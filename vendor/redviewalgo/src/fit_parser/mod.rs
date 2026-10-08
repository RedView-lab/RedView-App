//! Analyse des fichiers FIT : un lecteur rapide en flux (`fast`) avec la crate
//! `fitparser` en repli (`reference`) ; tous deux partagent le post-traitement
//! des points et le résumé d'activité (`summary`).

mod fast;
mod reference;
mod summary;
#[cfg(test)]
mod tests;

use crate::types::ActivityData;
use fast::parse_fit_fast;
use reference::parse_fit_reference;

/// Analyse un fichier FIT à partir d'octets bruts en `ActivityData`.
///
/// Chemin principal : un lecteur rapide en flux qui ne décode que les messages
/// Record et saute tous les autres grâce à leur longueur calculée (pas
/// d'allocation par message, pas de chaînes de nom de champ). Se replie sur la
/// crate de référence `fitparser` quand le lecteur rapide rencontre quoi que ce
/// soit d'inattendu, pour que les fichiers inhabituels gardent exactement
/// l'ancien comportement.
pub fn parse_fit(data: &[u8]) -> Result<ActivityData, String> {
    match parse_fit_fast(data) {
        Ok(activity) => Ok(activity),
        // Refus explicite (fichier lisible mais pas une activité) : pas de repli.
        Err(fast_err) if fast_err == NOT_AN_ACTIVITY_ERR => Err(fast_err),
        Err(_fast_err) => parse_fit_reference(data),
    }
}

/// Valeur de l'énumération `file` d'un Course (parcours planifié, vitesse synthétique).
const FIT_FILE_TYPE_COURSE: u8 = 6;

/// Un fichier « course » (parcours exporté d'un planificateur) a des
/// horodatages synthétiques à vitesse constante : l'utiliser comme sortie
/// d'entraînement fausse tout le profil (ex. FTP virtuelle 450 W).
pub const NOT_AN_ACTIVITY_ERR: &str =
    "Not an activity: this FIT file is a planned course (synthetic timing), not a recorded ride";

/// Analyse plusieurs fichiers FIT.
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

/// Garde le sport du message Session plutôt que celui du message Sport (une
/// Session est le résumé qui fait foi de ce qui a été enregistré).
fn merge_sport(current: &mut Option<u8>, from_session: bool, value: Option<u8>) {
    if let Some(v) = value {
        if from_session || current.is_none() {
            *current = Some(v);
        }
    }
}
