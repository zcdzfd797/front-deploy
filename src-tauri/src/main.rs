#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
  io,
  net::{TcpStream, ToSocketAddrs},
  path::PathBuf,
  process::{Child, Command, Stdio},
  sync::Mutex,
  thread,
  time::{Duration, Instant},
};

use tauri::{AppHandle, Manager, RunEvent};

const LOCAL_SERVER_HOST: &str = "127.0.0.1";
const LOCAL_SERVER_PORT: u16 = 3000;

struct ServerState(Mutex<Option<Child>>);

fn is_local_server_running() -> bool {
  let addr = format!("{LOCAL_SERVER_HOST}:{LOCAL_SERVER_PORT}");
  match addr.to_socket_addrs() {
    Ok(mut addrs) => addrs
      .next()
      .map(|socket| TcpStream::connect_timeout(&socket, Duration::from_millis(250)).is_ok())
      .unwrap_or(false),
    Err(_) => false,
  }
}

fn wait_for_server_ready(timeout: Duration) -> bool {
  let started_at = Instant::now();
  while started_at.elapsed() <= timeout {
    if is_local_server_running() {
      return true;
    }
    thread::sleep(Duration::from_millis(150));
  }
  false
}

fn resolve_server_root(app_handle: &AppHandle) -> io::Result<PathBuf> {
  if cfg!(debug_assertions) {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    return manifest_dir.parent().map(|p| p.to_path_buf()).ok_or_else(|| {
      io::Error::new(io::ErrorKind::NotFound, "无法定位项目根目录（开发模式）")
    });
  }

  app_handle
    .path()
    .resource_dir()
    .map_err(|err| io::Error::new(io::ErrorKind::NotFound, format!("无法读取资源目录: {err}")))
}

fn start_local_server(app_handle: &AppHandle) -> io::Result<Option<Child>> {
  if is_local_server_running() {
    println!("检测到本地服务已运行，复用现有服务。");
    return Ok(None);
  }

  let server_root = resolve_server_root(app_handle)?;
  let entry = server_root.join("server.js");
  if !entry.exists() {
    return Err(io::Error::new(
      io::ErrorKind::NotFound,
      format!("未找到服务入口文件: {}", entry.display()),
    ));
  }

  let mut child = Command::new("node")
    .arg("--openssl-legacy-provider")
    .arg("server.js")
    .current_dir(&server_root)
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null())
    .spawn()
    .map_err(|err| {
      io::Error::new(
        io::ErrorKind::NotFound,
        format!("启动本地服务失败: {err}。请确认已安装 Node.js"),
      )
    })?;

  if !wait_for_server_ready(Duration::from_secs(15)) {
    let _ = child.kill();
    let _ = child.wait();
    return Err(io::Error::new(
      io::ErrorKind::TimedOut,
      "本地服务启动超时（15s）",
    ));
  }

  println!("本地服务启动成功: http://{LOCAL_SERVER_HOST}:{LOCAL_SERVER_PORT}");
  Ok(Some(child))
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

fn main() {
  tauri::Builder::default()
    .manage(ServerState(Mutex::new(None)))
    .setup(|app| -> Result<(), Box<dyn std::error::Error>> {
      let child = start_local_server(app.handle())?;
      let state = app.state::<ServerState>();
      let mut guard = state
        .0
        .lock()
        .map_err(|_| io::Error::new(io::ErrorKind::Other, "服务状态锁获取失败"))?;
      *guard = child;
      Ok(())
    })
    .build(tauri::generate_context!())
    .expect("构建 Tauri 应用失败")
    .run(|app_handle, event| match event {
      RunEvent::ExitRequested { .. } | RunEvent::Exit => {
        stop_local_server(app_handle);
      }
      _ => {}
    });
}
