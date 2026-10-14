use std::ffi::OsStr;
use std::sync::Mutex;

/// Immutable first valid launch, retained only in this process's memory.
#[derive(Default)]
pub struct InitialConnection(Mutex<Option<String>>);

impl InitialConnection {
    pub fn from_arguments<S: AsRef<OsStr>>(arguments: impl IntoIterator<Item = S>) -> Self {
        let state = Self::default();
        state.remember_first_valid(arguments);
        state
    }

    pub fn remember_first_valid<S: AsRef<OsStr>>(&self, arguments: impl IntoIterator<Item = S>) {
        let arguments: Vec<_> = arguments
            .into_iter()
            .map(|value| value.as_ref().to_owned())
            .collect();
        if !is_connection_launch(&arguments) {
            return;
        }
        if let (Some(url), Ok(mut current)) = (arguments[1].to_str(), self.0.lock()) {
            if current.is_none() {
                *current = Some(url.to_owned());
            }
        }
    }

    pub fn first_url(&self) -> Option<String> {
        self.0.lock().ok().and_then(|current| current.clone())
    }
}

/// Only the bridge's supported connection launch should keep settings hidden.
/// Arguments are inspected in memory and never logged or persisted.
pub fn is_connection_launch<S: AsRef<OsStr>>(arguments: impl IntoIterator<Item = S>) -> bool {
    let mut arguments = arguments.into_iter();
    if arguments.next().is_none() {
        return false;
    }
    let Some(argument) = arguments.next() else {
        return false;
    };
    if arguments.next().is_some() {
        return false;
    }
    let Some(raw) = argument.as_ref().to_str() else {
        return false;
    };
    let Ok(url) = raw.parse::<tauri::Url>() else {
        return false;
    };
    if url.scheme() != "dsh-inochi2d-pet"
        || url.host_str() != Some("connect")
        || !matches!(url.path(), "" | "/")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.fragment().is_some()
    {
        return false;
    }
    let mut port = None;
    let mut token = None;
    let mut instance = None;
    for (key, value) in url.query_pairs() {
        let field = match key.as_ref() {
            "port" => &mut port,
            "token" => &mut token,
            "instance" => &mut instance,
            _ => return false,
        };
        if field.replace(value).is_some() {
            return false;
        }
    }
    let (Some(port), Some(token), Some(instance)) = (port, token, instance) else {
        return false;
    };
    if !(1..=5).contains(&port.len())
        || !matches!(port.as_bytes()[0], b'1'..=b'9')
        || !port.bytes().all(|byte| byte.is_ascii_digit())
        || port.parse::<u16>().is_err()
        || token.len() != 43
        || !token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
        || instance.len() != 36
    {
        return false;
    }
    uuid::Uuid::parse_str(&instance)
        .is_ok_and(|id| id.get_version_num() == 4 && id.get_variant() == uuid::Variant::RFC4122)
}

#[cfg(test)]
mod tests {
    use super::{is_connection_launch, InitialConnection};

    fn connection() -> String {
        format!(
            "dsh-inochi2d-pet://connect?port=41234&token={}&instance=12345678-1234-4234-8234-123456789abc",
            "a".repeat(43)
        )
    }

    #[test]
    fn the_first_valid_cold_launch_cannot_be_replaced() {
        let first = connection();
        let second = first.replace("port=41234", "port=41235");
        let state = InitialConnection::from_arguments(["pet.exe", first.as_str()]);
        state.remember_first_valid(["pet.exe", second.as_str()]);
        assert_eq!(state.first_url().as_deref(), Some(first.as_str()));
    }

    #[test]
    fn a_manual_launch_remembers_only_its_first_later_valid_connection() {
        let first = connection();
        let second = first.replace("port=41234", "port=41235");
        let state = InitialConnection::from_arguments(["pet.exe"]);
        state.remember_first_valid(["pet.exe", "dsh-inochi2d-pet://connect?invalid=1"]);
        state.remember_first_valid(["pet.exe", first.as_str(), "--unexpected"]);
        assert!(state.first_url().is_none());
        state.remember_first_valid(["pet.exe", first.as_str()]);
        state.remember_first_valid(["pet.exe", second.as_str()]);
        assert_eq!(state.first_url().as_deref(), Some(first.as_str()));
    }

    #[test]
    fn a_manual_launch_opens_settings_even_when_reopened() {
        assert!(!is_connection_launch(["pet.exe"]));
        assert!(!is_connection_launch(Vec::<String>::new()));
        assert!(!is_connection_launch(["pet.exe", "--settings"]));
    }

    #[test]
    fn a_bridge_connection_launch_keeps_settings_hidden() {
        let url = connection();
        assert!(is_connection_launch(["pet.exe", url.as_str()]));
        assert!(is_connection_launch([
            "pet.exe",
            url.replace("connect?", "connect/?").as_str()
        ]));
        assert!(!is_connection_launch(["pet.exe", url.as_str(), "--extra"]));
    }

    #[test]
    fn malformed_and_unrelated_urls_open_settings() {
        let url = connection();
        for invalid in [
            "not a url".into(),
            url.replace("dsh-inochi2d-pet:", "https:"),
            url.replace("//connect?", "//settings?"),
            url.replace("//connect?", "//user@connect?"),
            url.replace("//connect?", "//connect:1234?"),
            url.replace("//connect?", "//connect/path?"),
            format!("{url}#fragment"),
            format!("{url}#"),
            format!("{url}&unknown=1"),
            format!("{url}&port=1234"),
            url.replace("port=41234", "port=0"),
            url.replace("port=41234", "port=65536"),
            url.replace("port=41234", "port=04123"),
            url.replace("token=", "token=too-long-"),
            url.replace("instance=12345678-1234-4234", "instance=12345678-1234-1234"),
            "dsh-inochi2d-pet://connect".into(),
        ] {
            assert!(!is_connection_launch(["pet.exe", invalid.as_str()]));
        }
    }

    #[cfg(windows)]
    #[test]
    fn non_unicode_arguments_open_settings() {
        use std::ffi::OsString;
        use std::os::windows::ffi::OsStringExt;

        assert!(!is_connection_launch([
            OsString::from("pet.exe"),
            OsString::from_wide(&[0xd800]),
        ]));
    }
}
