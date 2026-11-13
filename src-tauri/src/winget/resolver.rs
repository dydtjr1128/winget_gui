//! Resolves a truncated upgrade-list package id to a full PackageIdentifier from
//! already-captured winget output (export JSON, installed list, catalog search).
//! Pure functions, no process access.

use super::parser::{
    has_truncated_marker, normalize_search_name, parse_search_rows, parse_upgrade_rows,
    search_name_match_prefixes, versions_match, ExportPackage,
};

fn norm(value: &str) -> String {
    value.trim().to_lowercase()
}

fn source_matches(wanted: &str, row_source: &str) -> bool {
    let row_source = norm(row_source);
    wanted.is_empty() || row_source.is_empty() || row_source == wanted
}

fn id_matches(id: &str, prefix: &str) -> bool {
    !id.is_empty() && !has_truncated_marker(id) && id.to_lowercase().starts_with(prefix)
}

fn unique(ids: impl Iterator<Item = String>) -> Option<String> {
    let mut seen: Vec<String> = Vec::new();
    for id in ids {
        if !seen.contains(&id) {
            seen.push(id);
        }
    }
    if seen.len() == 1 {
        seen.pop()
    } else {
        None
    }
}

pub fn from_search_output(output: &str, prefix: &str, source: &str, name: &str) -> Option<String> {
    let prefix = norm(prefix);
    if prefix.is_empty() {
        return None;
    }
    let source = norm(source);
    let name_prefixes = search_name_match_prefixes(name);
    unique(
        parse_search_rows(output)
            .into_iter()
            .filter(|row| {
                let row_name = normalize_search_name(&row.name);
                id_matches(&row.id, &prefix)
                    && (name_prefixes.is_empty() || name_prefixes.iter().any(|p| row_name.starts_with(p)))
                    && source_matches(&source, &row.source)
            })
            .map(|row| row.id),
    )
}

/// Installed-list resolution: only rows with an available upgrade are parsed,
/// so same-prefix packages that are already current drop out on their own.
pub fn from_list_output(
    output: &str,
    prefix: &str,
    source: &str,
    installed_version: &str,
    available_version: &str,
) -> Option<String> {
    let prefix = norm(prefix);
    if prefix.is_empty() {
        return None;
    }
    let source = norm(source);
    let mut matches: Vec<_> = parse_upgrade_rows(output)
        .into_iter()
        .filter(|row| id_matches(&row.id, &prefix) && source_matches(&source, &row.source))
        .collect();
    if matches.is_empty() {
        return None;
    }
    if matches.len() > 1 && !installed_version.is_empty() {
        let by: Vec<_> = matches.iter().filter(|r| versions_match(&r.installed_version, installed_version)).cloned().collect();
        if !by.is_empty() {
            matches = by;
        }
    }
    if matches.len() > 1 && !available_version.is_empty() {
        let by: Vec<_> = matches.iter().filter(|r| versions_match(&r.available_version, available_version)).cloned().collect();
        if !by.is_empty() {
            matches = by;
        }
    }
    unique(matches.into_iter().map(|r| r.id))
}

/// Export resolution. When the installed version is known it must match, even
/// for a single candidate, so a same-prefix sibling is never picked; exact
/// equality unless the upgrade table itself truncated the version.
pub fn from_export(packages: &[ExportPackage], prefix: &str, source: &str, installed_version: &str) -> Option<String> {
    let prefix = norm(prefix);
    if prefix.is_empty() {
        return None;
    }
    let source = norm(source);
    let truncated = has_truncated_marker(installed_version);
    let target = installed_version.trim();
    unique(
        packages
            .iter()
            .filter(|p| id_matches(&p.id, &prefix) && source_matches(&source, &p.source))
            .filter(|p| {
                installed_version.is_empty()
                    || if truncated { versions_match(&p.version, installed_version) } else { p.version.trim() == target }
            })
            .map(|p| p.id.clone()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::winget::parser::{decode_export_bytes, parse_export_packages};

    const EXPORT_JSON: &str = r#"{"Sources":[{"Packages":[
        {"PackageIdentifier":"Microsoft.DotNet.DesktopRuntime.10","Version":"10.0.8"},
        {"PackageIdentifier":"Microsoft.DotNet.DesktopRuntime.8","Version":"8.0.27"},
        {"PackageIdentifier":"Microsoft.DotNet.DesktopRuntime.9","Version":"9.0.16"},
        {"PackageIdentifier":"Microsoft.VCRedist.2015+.x86","Version":"14.51.36231.0"},
        {"PackageIdentifier":"Microsoft.VCRedist.2015+.x64","Version":"14.50.35719.0"},
        {"PackageIdentifier":"Microsoft.DotNet.AspNetCore.8","Version":"8.0.27"}],
        "SourceDetails":{"Name":"winget"}}],"WinGetVersion":"1.13.0"}"#;

    fn pkg(id: &str, version: &str, source: &str) -> ExportPackage {
        ExportPackage { id: id.into(), version: version.into(), source: source.into() }
    }

    #[test]
    fn list_ignores_same_prefix_package_that_is_current() {
        let out = "
이름                                                    장치 ID                      버전          사용 가능     원본
-----------------------------------------------------------------------------------------------------------------------
Microsoft Visual C++ v14 Redistributable (x64) - 14.50… Microsoft.VCRedist.2015+.x64 14.50.35719.0 14.51.36231.0 winget
Microsoft Visual C++ 2015-2022 Redistributable (x86) -… Microsoft.VCRedist.2015+.x86 14.51.36231.0               winget
";
        assert_eq!(
            from_list_output(out, "Microsoft.VCRedist.2015+.x", "winget", "14.50.35719.0", "14.51.36231.0").as_deref(),
            Some("Microsoft.VCRedist.2015+.x64")
        );
    }

    #[test]
    fn list_disambiguates_by_installed_version_or_gives_up() {
        let out = "
Name                           Id                Version   Available  Source
------------------------------------------------------------------------------
Foo Bar (x64)                  Vendor.Foo.x64    1.0.0     2.0.0      winget
Foo Bar (x86)                  Vendor.Foo.x86    1.5.0     2.0.0      winget
";
        assert_eq!(from_list_output(out, "Vendor.Foo.x", "winget", "1.5.0", "2.0.0").as_deref(), Some("Vendor.Foo.x86"));
        let ambiguous = out.replace("1.5.0", "1.0.0");
        assert_eq!(from_list_output(&ambiguous, "Vendor.Foo.x", "winget", "1.0.0", "2.0.0"), None);
    }

    #[test]
    fn search_resolves_and_uses_display_name() {
        let single = "
Name                           Id                                      Version   Source
--------------------------------------------------------------------------------------
Visual Studio Build Tools 2022 Microsoft.VisualStudio.2022.BuildTools 17.14.32 winget
";
        assert_eq!(
            from_search_output(single, "Microsoft.VisualStudio.202", "winget", "").as_deref(),
            Some("Microsoft.VisualStudio.2022.BuildTools")
        );
        let two = "
Name                           Id                                      Version   Source
--------------------------------------------------------------------------------------
Visual Studio Community 2022   Microsoft.VisualStudio.2022.Community   17.14.32 winget
Visual Studio Build Tools 2022 Microsoft.VisualStudio.2022.BuildTools  17.14.32 winget
";
        assert_eq!(from_search_output(two, "Microsoft.VisualStudio.2022", "winget", ""), None);
        assert_eq!(
            from_search_output(two, "Microsoft.VisualStudio.202", "winget", "Visual Studio Build Tools …").as_deref(),
            Some("Microsoft.VisualStudio.2022.BuildTools")
        );
    }

    #[test]
    fn search_handles_versioned_names_and_missing_source() {
        let out = "
이름          장치 ID                      버전
------------------------------------------------
Clawd on Desk rullerzhou-afk.clawd-on-desk 0.8.0
";
        assert_eq!(
            from_search_output(out, "rullerzhou-afk.clawd-on-de", "winget", "Clawd on Desk 0.7.1").as_deref(),
            Some("rullerzhou-afk.clawd-on-desk")
        );
        let vs = "
이름                                   장치 ID                                  버전
----------------------------------------------------------------------------------------
Visual Studio Enterprise 2017          Microsoft.VisualStudio.2017.Enterprise   15.9.70
Visual Studio BuildTools 2019          Microsoft.VisualStudio.2019.BuildTools   16.11.56
Microsoft Visual Studio Community 2019 Microsoft.VisualStudio.2019.Community    16.11.53
";
        assert_eq!(
            from_search_output(vs, "Microsoft.VisualStudio.201", "winget", "Visual Studio Build Tools …").as_deref(),
            Some("Microsoft.VisualStudio.2019.BuildTools")
        );
    }

    #[test]
    fn parses_export_with_bom_and_utf16() {
        let packages = parse_export_packages(EXPORT_JSON);
        assert_eq!(packages.len(), 6);
        assert_eq!(packages[0], pkg("Microsoft.DotNet.DesktopRuntime.10", "10.0.8", "winget"));

        let with_bom = format!("{}{}", char::from_u32(0xfeff).unwrap(), EXPORT_JSON);
        assert_eq!(parse_export_packages(&with_bom).len(), 6);
        assert!(parse_export_packages("not json").is_empty());
        assert!(parse_export_packages("{}").is_empty());

        let mut utf16 = vec![0xff, 0xfe];
        utf16.extend(EXPORT_JSON.encode_utf16().flat_map(|u| u.to_le_bytes()));
        assert_eq!(parse_export_packages(&decode_export_bytes(&utf16)).len(), 6);
    }

    #[test]
    fn export_resolves_by_installed_version() {
        let p = parse_export_packages(EXPORT_JSON);
        assert_eq!(from_export(&p, "Microsoft.DotNet.DesktopRu", "winget", "9.0.16").as_deref(), Some("Microsoft.DotNet.DesktopRuntime.9"));
        assert_eq!(from_export(&p, "Microsoft.VCRedist.2015+.x", "winget", "14.51.36231.0").as_deref(), Some("Microsoft.VCRedist.2015+.x86"));
        assert_eq!(from_export(&p, "Microsoft.DotNet.AspNetCor", "winget", "").as_deref(), Some("Microsoft.DotNet.AspNetCore.8"));
        assert_eq!(from_export(&p, "Nonexistent.Package", "winget", "1.0.0"), None);
    }

    #[test]
    fn export_refuses_ambiguous_or_mismatched_candidates() {
        let two = [pkg("Vendor.Foo.x64", "1.0.0", "winget"), pkg("Vendor.Foo.x86", "1.0.0", "winget")];
        assert_eq!(from_export(&two, "Vendor.Foo.x", "winget", "1.0.0"), None);
        assert_eq!(from_export(&[pkg("Some.StorePackage", "1.0.0", "msstore")], "Some.Store", "winget", "1.0.0"), None);
        assert_eq!(from_export(&[pkg("Microsoft.DotNet.DesktopRuntime.10", "10.0.8", "winget")], "Microsoft.DotNet.DesktopRu", "winget", "8.0.27"), None);
        assert_eq!(from_export(&[pkg("Vendor.Tool.Stable", "9", "winget")], "Vendor.Tool", "winget", "9.1"), None);
        assert_eq!(
            from_export(&[pkg("Warp.Warp.Preview", "v0.2026.06.03.09.49.stable_02", "winget")], "Warp.Warp.Pre", "winget", "v0.2026.06.03.09.49.stable…").as_deref(),
            Some("Warp.Warp.Preview")
        );
    }
}
