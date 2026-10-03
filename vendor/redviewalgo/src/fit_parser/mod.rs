//! FIT file parsing: a fast streaming reader (`fast`) with the `fitparser`
//! crate as fallback (`reference`); both share the point post-processing and
//! activity summary (`summary`).

mod fast;
mod reference;
mod summary;
#[cfg(test)]
mod tests;

use crate::types::ActivityData;
use fast::parse_fit_fast;
use reference::parse_fit_reference;

/// Parse a single FIT file from raw bytes into `ActivityData`.
///
/// Primary path: a fast streaming reader that only decodes Record messages
/// and skips every other message by computed length (no per-message
/// allocation, no field-name strings). Falls back to the reference
/// `fitparser` crate when the fast reader hits anything unexpected, so
/// unusual files keep the exact legacy behaviour.
pub fn parse_fit(data: &[u8]) -> Result<ActivityData, String> {
    match parse_fit_fast(data) {
        Ok(activity) => Ok(activity),
        // Refus explicite (fichier lisible mais pas une activité) : pas de repli.
        Err(fast_err) if fast_err == NOT_AN_ACTIVITY_ERR => Err(fast_err),
        Err(_fast_err) => parse_fit_reference(data),
    }
}

/// `file` enum value for a Course (parcours planifié, vitesse synthétique).
const FIT_FILE_TYPE_COURSE: u8 = 6;

/// Un fichier « course » (parcours exporté d'un planificateur) a des
/// horodatages synthétiques à vitesse constante : l'utiliser comme sortie
/// d'entraînement fausse tout le profil (ex. FTP virtuelle 450 W).
pub const NOT_AN_ACTIVITY_ERR: &str =
    "Not an activity: this FIT file is a planned course (synthetic timing), not a recorded ride";

/// Parse multiple FIT files.
pub fn parse_fit_batch(files: &[&[u8]]) -> Result<Vec<ActivityData>, String> {
    let mut results = Vec::with_capacity(files.len());
    for (i, data) in files.iter().enumerate() {
        match parse_fit(data) {
            Ok(activity) => results.push(activity),
            Err(e) => return Err(format!("Error parsing FIT file #{}: {}", i + 1, e)),
        }
    }
    Ok(results)
}

/// Keep the Session sport over the Sport message one (a Session is the
/// authoritative summary of what was recorded).
fn merge_sport(current: &mut Option<u8>, from_session: bool, value: Option<u8>) {
    if let Some(v) = value {
        if from_session || current.is_none() {
            *current = Some(v);
        }
    }
}
