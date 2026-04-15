#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
  fs::OpenOptions,
  io,
  io::Write,
  net::{TcpListener, TcpStream, ToSocketAddrs},
  path::PathBuf,
  process::{Child, Command, Stdio},
  sync::Mutex,
  thread,
  time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use tauri::{path::BaseDirectory, AppHandle, Manager, RunEvent, Url};

const LOCAL_SERVER_HOST: &str = "127.0.0.1";

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

struct ServerState(Mutex<Option<Child>>);

fn pick_available_port() -> io::Result<u16> {
  let listener = TcpListener::bind((LOCAL_SERVER_HOST, 0))?;
  let port = listener.local_addr()?.port();
  drop(listener);
  Ok(port)
}

fn is_local_server_running(port: u16) -> bool {
  let addr = format!("{LOCAL_SERVER_HOST}:{port}");
  match addr.to_socket_addrs() {
    Ok(mut addrs) => addrs
      .next()
      .map(|socket| TcpStream::connect_timeout(&socket, Duration::from_millis(250)).is_ok())
      .unwrap_or(false),
    Err(_) => false,
  }
}

fn is_expected_local_server(port: u16, instance_id: &str) -> bool {
  let addr = format!("{LOCAL_SERVER_HOST}:{port}");
  let mut stream = match TcpStream::connect(addr) {
    Ok(s) => s,
    Err(_) => return false,
  };
  let _ = stream.set_read_timeout(Some(Duration::from_millis(300)));
  let _ = stream.set_write_timeout(Some(Duration::from_millis(300)));
  let request = format!(
    "GET /api/_health HTTP/1.1\r\nHost: {LOCAL_SERVER_HOST}:{port}\r\nConnection: close\r\n\r\n"
  );
  if stream.write_all(request.as_bytes()).is_err() {
    return false;
  }

  let mut buf = Vec::with_capacity(512);
  if std::io::Read::read_to_end(&mut stream, &mut buf).is_err() {
    return false;
  }
  let text = String::from_utf8_lossy(&buf);
  text.contains("\"ok\":true") && text.contains(&format!("\"instanceId\":\"{instance_id}\""))
}

fn wait_for_server_ready(port: u16, instance_id: &str, timeout: Duration) -> bool {
  let started_at = Instant::now();
  while started_at.elapsed() <= timeout {
    if is_local_server_running(port) && is_expected_local_server(port, instance_id) {
      return true;
    }
    thread::sleep(Duration::from_millis(150));
  }
  false
}

fn generate_instance_id() -> String {
  let pid = std::process::id();
  let ms = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|d| d.as_millis())
    .unwrap_or(0);
  format!("{pid}-{ms}")
}

fn resolve_server_root(app_handle: &AppHandle) -> io::Result<PathBuf> {
  if cfg!(debug_assertions) {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    return manifest_dir.parent().map(|p| p.to_path_buf()).ok_or_else(|| {
      io::Error::new(io::ErrorKind::NotFound, "failed to locate project root in dev mode")
    });
  }

  let mut checked = Vec::new();

  if let Ok(server_entry) = app_handle.path().resolve("server.js", BaseDirectory::Resource) {
    checked.push(server_entry.clone());
    if server_entry.exists() {
      if let Some(parent) = server_entry.parent() {
        return Ok(parent.to_path_buf());
      }
    }
  }

  if let Ok(resource_dir) = app_handle.path().resource_dir() {
    let direct = resource_dir.join("server.js");
    checked.push(direct.clone());
    if direct.exists() {
      return Ok(resource_dir.clone());
    }

    let up_dir = resource_dir.join("_up_");
    let up_entry = up_dir.join("server.js");
    checked.push(up_entry.clone());
    if up_entry.exists() {
      return Ok(up_dir);
    }
  }

  if let Ok(exe_path) = std::env::current_exe() {
    if let Some(exe_dir) = exe_path.parent() {
      let direct = exe_dir.join("server.js");
      checked.push(direct.clone());
      if direct.exists() {
        return Ok(exe_dir.to_path_buf());
      }

      let resources = exe_dir.join("resources");
      checked.push(resources.join("server.js"));
      if resources.join("server.js").exists() {
        return Ok(resources);
      }

      let up_dir = exe_dir.join("_up_");
      let up_entry = up_dir.join("server.js");
      checked.push(up_entry.clone());
      if up_entry.exists() {
        return Ok(up_dir);
      }

      let resources_up = exe_dir.join("resources").join("_up_");
      let resources_up_entry = resources_up.join("server.js");
      checked.push(resources_up_entry.clone());
      if resources_up_entry.exists() {
        return Ok(resources_up);
      }
    }
  }

  Err(io::Error::new(
    io::ErrorKind::NotFound,
    format!(
      "server.js was not found in bundled resource locations; checked: {}",
      checked
        .iter()
        .map(|p| p.display().to_string())
        .collect::<Vec<_>>()
        .join(", ")
    ),
  ))
}

fn start_local_server(app_handle: &AppHandle) -> io::Result<(Child, u16)> {
  let server_root = resolve_server_root(app_handle)?;
  let entry = server_root.join("server.js");
  if !entry.exists() {
    return Err(io::Error::new(
      io::ErrorKind::NotFound,
      format!("Server entry file not found: {}", entry.display()),
    ));
  }

  let port = pick_available_port()?;
  let instance_id = generate_instance_id();

  let mut child = Command::new("node")
    .arg("--openssl-legacy-provider")
    .arg("server.js")
    .env("HOST", LOCAL_SERVER_HOST)
    .env("PORT", port.to_string())
    .env("APP_INSTANCE_ID", &instance_id)
    .current_dir(&server_root)
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null())
    .spawn_with_no_window()
    .map_err(|err| {
      io::Error::new(
        io::ErrorKind::NotFound,
        format!("Failed to start local service: {err}. Please ensure Node.js is installed."),
      )
    })?;

  if !wait_for_server_ready(port, &instance_id, Duration::from_secs(15)) {
    let _ = child.kill();
    let _ = child.wait();
    return Err(io::Error::new(
      io::ErrorKind::TimedOut,
      "Local service startup timed out (15s).",
    ));
  }

  println!(
    "Local service started successfully: http://{LOCAL_SERVER_HOST}:{port}"
  );
  Ok((child, port))
}

trait SpawnNoWindow {
  fn spawn_with_no_window(&mut self) -> io::Result<Child>;
}

impl SpawnNoWindow for Command {
  fn spawn_with_no_window(&mut self) -> io::Result<Child> {
    #[cfg(windows)]
    {
      use std::os::windows::process::CommandExt;
      self.creation_flags(CREATE_NO_WINDOW);
    }
    self.spawn()
  }
}

fn stop_local_server(app_handle: &AppHandle) {
  let state = app_handle.state::<ServerState>();
  let mut guard = match state.0.lock() {
    Ok(lock) => lock,
    Err(_) => return,
  };

  if let Some(child) = guard.as_mut() {
    let _ = child.kill();
    let _ = child.wait();
  }
  *guard = None;
}

fn escape_js_string(input: &str) -> String {
  input
    .replace('\\', "\\\\")
    .replace('\'', "\\'")
    .replace('\r', "")
    .replace('\n', "\\n")
}

fn append_startup_log(message: &str) {
  let log_path = std::env::temp_dir().join("front-deploy-tauri.log");
  if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(log_path) {
    let _ = writeln!(file, "{message}");
  }
}

fn show_startup_error(app: &tauri::App, message: &str) {
  append_startup_log(message);
  if let Some(main_window) = app.get_webview_window("main") {
    let safe = escape_js_string(message);
    let script = format!(
      "document.title='前端部署管理器 - 启动失败';\
       document.body.style.margin='0';\
       document.body.style.fontFamily='Segoe UI,Microsoft YaHei,sans-serif';\
       document.body.style.background='#0f172a';\
       document.body.style.color='#e2e8f0';\
       document.body.innerHTML='';\
       const wrap=document.createElement(\"div\");\
       wrap.style.padding='24px';\
       const h2=document.createElement(\"h2\");\
       h2.textContent='应用启动失败';\
       h2.style.margin='0 0 12px 0';\
       const p=document.createElement(\"p\");\
       p.textContent='请确认 Node.js 可用后重试。详细信息如下：';\
       p.style.margin='0 0 12px 0';\
       const pre=document.createElement(\"pre\");\
       pre.textContent='{safe}';\
       pre.style.whiteSpace='pre-wrap';\
       pre.style.wordBreak='break-word';\
       pre.style.padding='12px';\
       pre.style.background='#111827';\
       pre.style.border='1px solid #334155';\
       pre.style.borderRadius='8px';\
       wrap.appendChild(h2);\
       wrap.appendChild(p);\
       wrap.appendChild(pre);\
       document.body.appendChild(wrap);"
    );
    let _ = main_window.eval(&script);
  }
}

fn main() {
  tauri::Builder::default()
    .manage(ServerState(Mutex::new(None)))
    .setup(|app| -> Result<(), Box<dyn std::error::Error>> {
      match start_local_server(app.handle()) {
        Ok((child, port)) => {
          if let Some(main_window) = app.get_webview_window("main") {
            if let Ok(target_url) = Url::parse(&format!("http://{LOCAL_SERVER_HOST}:{port}")) {
              let _ = main_window.navigate(target_url);
            }
          }

          let state = app.state::<ServerState>();
          let mut guard = state
            .0
            .lock()
            .map_err(|_| io::Error::other("failed to lock server state"))?;
          *guard = Some(child);
        }
        Err(err) => {
          show_startup_error(app, &format!("Local server startup failed: {err}"));
        }
      }
      Ok(())
    })
    .build(tauri::generate_context!())
    .expect("failed to build tauri app")
    .run(|app_handle, event| match event {
      RunEvent::ExitRequested { .. } | RunEvent::Exit => {
        stop_local_server(app_handle);
      }
      _ => {}
    });
}
