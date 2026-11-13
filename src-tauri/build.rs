// Release builds embed a requireAdministrator manifest so the exe always starts
// elevated (UAC on launch), since installing and removing packages usually needs
// admin rights. Debug builds (`tauri dev`, `cargo test`) keep the default
// manifest so they run from a normal terminal.
const ADMIN_MANIFEST: &str = r#"<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <dependency>
    <dependentAssembly>
      <assemblyIdentity type="win32" name="Microsoft.Windows.Common-Controls" version="6.0.0.0" processorArchitecture="*" publicKeyToken="6595b64144ccf1df" language="*" />
    </dependentAssembly>
  </dependency>
  <trustInfo xmlns="urn:schemas-microsoft-com:asm.v3">
    <security>
      <requestedPrivileges>
        <requestedExecutionLevel level="requireAdministrator" uiAccess="false" />
      </requestedPrivileges>
    </security>
  </trustInfo>
</assembly>
"#;

fn main() {
    let mut attributes = tauri_build::Attributes::new();
    if std::env::var("PROFILE").as_deref() == Ok("release") {
        attributes = attributes
            .windows_attributes(tauri_build::WindowsAttributes::new().app_manifest(ADMIN_MANIFEST));
    }
    tauri_build::try_build(attributes).expect("failed to run tauri build script");
}
