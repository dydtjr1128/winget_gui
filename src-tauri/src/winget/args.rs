//! winget argument builders. Every mutating command pins `--exact` and
//! disables interactivity.

#[derive(Debug, Default, Clone)]
pub struct UpgradeOptions {
    pub source: String,
    pub silent: bool,
    pub include_unknown: bool,
    pub include_pinned: bool,
    pub ignore_hash: bool,
    /// `--force`: continue past non-security checks (e.g. reinstall the same
    /// version, or install over a copy `upgrade` cannot match).
    pub force: bool,
}

fn s(values: &[&str]) -> Vec<String> {
    values.iter().map(|v| v.to_string()).collect()
}

pub fn list_args(include_unknown: bool, include_pinned: bool) -> Vec<String> {
    let mut args = s(&["upgrade", "--accept-source-agreements"]);
    if include_unknown {
        args.push("--include-unknown".into());
    }
    if include_pinned {
        args.push("--include-pinned".into());
    }
    args
}

fn query_by_id(command: &str, prefix: &str, source: &str) -> Vec<String> {
    let mut args = s(&[command, "--id", prefix]);
    if !source.is_empty() {
        args.extend(s(&["--source", source]));
    }
    args.extend(s(&["--accept-source-agreements", "--disable-interactivity"]));
    args
}

pub fn search_args(prefix: &str, source: &str) -> Vec<String> {
    query_by_id("search", prefix, source)
}

pub fn list_by_id_args(prefix: &str, source: &str) -> Vec<String> {
    query_by_id("list", prefix, source)
}

pub fn export_args(output_path: &str) -> Vec<String> {
    s(&[
        "export",
        "--output",
        output_path,
        "--include-versions",
        "--accept-source-agreements",
        "--disable-interactivity",
    ])
}

fn upgrade_args_for(selector: &str, value: &str, o: &UpgradeOptions) -> Vec<String> {
    let mut args = s(&[
        "upgrade",
        selector,
        value,
        "--exact",
        "--accept-package-agreements",
        "--accept-source-agreements",
        "--disable-interactivity",
    ]);
    // Pin the source so a transient msstore outage cannot abort winget-source upgrades.
    if !o.source.is_empty() {
        args.extend(s(&["--source", &o.source]));
    }
    if o.silent {
        args.push("--silent".into());
    }
    if o.include_unknown {
        args.push("--include-unknown".into());
    }
    if o.include_pinned {
        args.push("--include-pinned".into());
    }
    if o.ignore_hash {
        args.push("--ignore-security-hash".into());
    }
    if o.force {
        args.push("--force".into());
    }
    args
}

pub fn upgrade_args(id: &str, o: &UpgradeOptions) -> Vec<String> {
    upgrade_args_for("--id", id, o)
}

pub fn upgrade_by_name_args(name: &str, o: &UpgradeOptions) -> Vec<String> {
    upgrade_args_for("--name", name, o)
}

fn id_command(command: &str, id: &str, source: &str, silent: bool, accept_package: bool) -> Vec<String> {
    let mut args = s(&[command, "--id", id, "--exact"]);
    if accept_package {
        args.push("--accept-package-agreements".into());
    }
    args.extend(s(&["--accept-source-agreements", "--disable-interactivity"]));
    if !source.is_empty() {
        args.extend(s(&["--source", source]));
    }
    if silent {
        args.push("--silent".into());
    }
    args
}

/// Fresh install of the latest version. With `force` it also installs over an
/// existing copy, which is the fallback for packages `upgrade` cannot match.
pub fn install_args(id: &str, source: &str, silent: bool, force: bool) -> Vec<String> {
    let mut args = id_command("install", id, source, silent, true);
    if force {
        args.push("--force".into());
    }
    args
}

pub fn uninstall_args(id: &str, source: &str, silent: bool) -> Vec<String> {
    id_command("uninstall", id, source, silent, false)
}

pub fn enable_hash_override_args() -> Vec<String> {
    s(&["settings", "--enable", "InstallerHashOverride"])
}

pub fn disable_hash_override_args() -> Vec<String> {
    s(&["settings", "--disable", "InstallerHashOverride"])
}

pub fn settings_export_args() -> Vec<String> {
    s(&["settings", "export"])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_exact_id_upgrade_args_with_source() {
        let o = UpgradeOptions { source: "winget".into(), silent: true, ..Default::default() };
        assert_eq!(
            upgrade_args("Git.Git", &o),
            s(&[
                "upgrade",
                "--id",
                "Git.Git",
                "--exact",
                "--accept-package-agreements",
                "--accept-source-agreements",
                "--disable-interactivity",
                "--source",
                "winget",
                "--silent"
            ])
        );
        assert!(!upgrade_args("Git.Git", &UpgradeOptions::default()).contains(&"--source".to_string()));
    }

    #[test]
    fn uninstall_does_not_accept_package_agreements() {
        let args = uninstall_args("Git.Git", "winget", true);
        assert!(!args.contains(&"--accept-package-agreements".to_string()));
        assert!(args.ends_with(&s(&["--source", "winget", "--silent"])));
        assert!(install_args("Git.Git", "", false, false).contains(&"--accept-package-agreements".to_string()));
    }

    #[test]
    fn ignore_hash_flag_only_when_requested() {
        let o = UpgradeOptions { ignore_hash: true, ..Default::default() };
        assert!(upgrade_args("A.B", &o).contains(&"--ignore-security-hash".to_string()));
        assert!(!upgrade_args("A.B", &UpgradeOptions::default()).contains(&"--ignore-security-hash".to_string()));
    }

    #[test]
    fn force_flag_only_when_requested() {
        let forced = UpgradeOptions { force: true, ..Default::default() };
        assert!(upgrade_args("A.B", &forced).ends_with(&s(&["--force"])));
        assert!(upgrade_by_name_args("A B", &forced).contains(&"--force".to_string()));
        assert!(!upgrade_args("A.B", &UpgradeOptions::default()).contains(&"--force".to_string()));
        // The same command the user ran by hand to rescue a stuck package.
        assert_eq!(
            install_args("Microsoft.PowerShell", "winget", false, true),
            s(&[
                "install",
                "--id",
                "Microsoft.PowerShell",
                "--exact",
                "--accept-package-agreements",
                "--accept-source-agreements",
                "--disable-interactivity",
                "--source",
                "winget",
                "--force"
            ])
        );
        assert!(!install_args("A.B", "", false, false).contains(&"--force".to_string()));
        assert!(!uninstall_args("A.B", "", false).contains(&"--force".to_string()));
    }

    #[test]
    fn builds_truncated_id_resolution_args() {
        assert_eq!(
            search_args("Microsoft.VisualStudio.202", "winget"),
            s(&["search", "--id", "Microsoft.VisualStudio.202", "--source", "winget", "--accept-source-agreements", "--disable-interactivity"])
        );
        assert_eq!(list_by_id_args("A.B", ""), s(&["list", "--id", "A.B", "--accept-source-agreements", "--disable-interactivity"]));
        assert_eq!(
            export_args("C:\\Temp\\x.json"),
            s(&["export", "--output", "C:\\Temp\\x.json", "--include-versions", "--accept-source-agreements", "--disable-interactivity"])
        );
    }

    #[test]
    fn list_args_visibility_options() {
        assert_eq!(list_args(true, true), s(&["upgrade", "--accept-source-agreements", "--include-unknown", "--include-pinned"]));
    }
}
