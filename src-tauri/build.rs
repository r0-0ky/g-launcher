fn main() {
    // Пересобирать, если изменился зашиваемый Client ID.
    println!("cargo:rerun-if-env-changed=GANDONI_MS_CLIENT_ID");
    tauri_build::build()
}
