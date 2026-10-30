/// Match the Windows display language, not the active keyboard/input language.
/// No host credentials or user content are involved in locale selection.
pub fn current() -> &'static str {
    #[cfg(all(windows, not(test)))]
    {
        #[link(name = "kernel32")]
        extern "system" {
            fn GetUserDefaultUILanguage() -> u16;
        }
        // SAFETY: this Win32 getter takes no pointers and has no side effects.
        language_from_id(unsafe { GetUserDefaultUILanguage() })
    }
    #[cfg(any(not(windows), test))]
    "zh-CN"
}

#[cfg(any(windows, test))]
fn language_from_id(id: u16) -> &'static str {
    if id == 0 || id & 0x03ff == 0x04 {
        "zh-CN"
    } else {
        "en"
    }
}

pub fn text<'a>(chinese: &'a str, english: &'a str) -> &'a str {
    if current() == "en" {
        english
    } else {
        chinese
    }
}

pub fn message(source: &str) -> &str {
    if current() == "en" {
        crate::native_messages::english(source)
    } else {
        source
    }
}

macro_rules! localized_format {
    ($zh:literal, $en:literal $(, $argument:expr)* $(,)?) => {
        if $crate::locale::current() == "en" { format!($en $(, $argument)*) }
        else { format!($zh $(, $argument)*) }
    };
}
pub(crate) use localized_format;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn display_language_handles_chinese_variants_and_other_languages() {
        assert_eq!(language_from_id(0x0804), "zh-CN");
        assert_eq!(language_from_id(0x0404), "zh-CN");
        assert_eq!(language_from_id(0x0409), "en");
        assert_eq!(language_from_id(0x0411), "en");
        assert_eq!(language_from_id(0), "zh-CN");
    }
}
