use crate::math::{gradient_pct, haversine_distance, median_filter_elevations, smooth_elevations};
use crate::types::{Route, RoutePoint, SurfaceType};
use quick_xml::events::Event;
use quick_xml::Reader;

/// Nombre maximal de points de route par défaut pour la prédiction.
const DEFAULT_MAX_ROUTE_POINTS: usize = 15_000;

/// Distance minimale entre deux points consécutifs (mètres).
const MIN_POINT_SPACING_M: f64 = 5.0;

/// Fenêtre de lissage gaussien par défaut, en mètres. Correspond à peu près à
/// la résolution à laquelle le terrain réel compte pour l'effort à vélo
/// (≈ 120 m saisit les segments de côte sans effacer les rampes courtes).
const DEFAULT_SMOOTH_WINDOW_M: f64 = 120.0;

/// Fenêtre du filtre médian (nombre d'échantillons) appliqué avant le
/// lisseur gaussien. 5 suffit à effacer les erreurs de DEM d'un seul
/// échantillon tout en préservant les vrais reliefs (toute rampe de plus de
/// ≈ 3 échantillons survit intacte).
const MEDIAN_FILTER_WINDOW: usize = 5;

/// Analyse un fichier GPX à partir d'octets bruts en une `Route`.
/// `max_points` règle le sous-échantillonnage (None = 15000 par défaut).
/// `smooth_window_m` règle le lissage de l'altitude (None = 50 m par défaut).
pub fn parse_gpx(
    data: &[u8],
    max_points: Option<usize>,
    smooth_window_m: Option<f64>,
) -> Result<Route, String> {
    let mut raw_points = parse_gpx_points(data)?;

    // Complète les altitudes manquantes par interpolation linéaire entre les
    // points connus. Sans cela, un seul <ele> manquant au milieu d'une
    // descente de montagne serait traité comme 0 m et créerait une fausse
    // falaise de −800 m que le lisseur ne peut pas entièrement effacer.
    interpolate_missing_elevations(&mut raw_points);
    let raw_points: Vec<(f64, f64, f64)> =
        raw_points.into_iter().map(|(lat, lon, ele, _)| (lat, lon, ele)).collect();

    let max_pts = max_points.unwrap_or(DEFAULT_MAX_ROUTE_POINTS);
    let smooth_w = smooth_window_m.unwrap_or(DEFAULT_SMOOTH_WINDOW_M);
    build_route(raw_points, max_pts, smooth_w)
}

/// Points bruts d'un GPX : (lat, lon, ele, ele présente), sans aucun traitement.
pub fn parse_gpx_points(data: &[u8]) -> Result<Vec<(f64, f64, f64, bool)>, String> {
    let xml = std::str::from_utf8(data).map_err(|e| format!("GPX is not valid UTF-8: {e}"))?;

    // Préallocation selon le nombre de points estimé (~1 point pour 80 octets de GPX)
    let estimated_points = data.len() / 80;
    let mut reader = Reader::from_str(xml);
    // (lat, lon, ele, has_ele) — has_ele = false signifie que le trkpt n'avait
    // pas d'enfant <ele> et que ele doit être traité comme manquant (interpolé plus tard).
    let mut raw_points: Vec<(f64, f64, f64, bool)> = Vec::with_capacity(estimated_points.min(500_000));
    let mut in_trkpt = false;
    let mut in_ele = false;
    let mut current_lat: f64 = 0.0;
    let mut current_lon: f64 = 0.0;
    let mut current_ele: f64 = 0.0;
    let mut current_has_ele: bool = false;
    let mut buf = Vec::with_capacity(256);

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) => {
                let local_name = e.local_name();
                match local_name.as_ref() {
                    b"trkpt" | b"rtept" => {
                        in_trkpt = true;
                        current_ele = 0.0;
                        current_has_ele = false;
                        current_lat = 0.0;
                        current_lon = 0.0;
                        read_lat_lon_attrs(e, &mut current_lat, &mut current_lon);
                    }
                    b"ele" if in_trkpt => {
                        in_ele = true;
                    }
                    _ => {}
                }
            }
            Ok(Event::Empty(ref e)) => {
                let local_name = e.local_name();
                if local_name.as_ref() == b"trkpt" || local_name.as_ref() == b"rtept" {
                    // <trkpt lat="..." lon="..." /> auto-fermant — pas d'enfant d'altitude
                    let mut lat = 0.0;
                    let mut lon = 0.0;
                    read_lat_lon_attrs(e, &mut lat, &mut lon);
                    raw_points.push((lat, lon, 0.0, false));
                }
            }
            Ok(Event::Text(ref e)) if in_ele => {
                let txt = e.unescape().unwrap_or_default();
                if let Ok(v) = txt.trim().parse::<f64>() {
                    current_ele = v;
                    current_has_ele = true;
                }
            }
            Ok(Event::End(ref e)) => {
                let local_name = e.local_name();
                match local_name.as_ref() {
                    b"trkpt" | b"rtept" => {
                        if in_trkpt {
                            raw_points.push((current_lat, current_lon, current_ele, current_has_ele));
                            in_trkpt = false;
                        }
                    }
                    b"ele" => {
                        in_ele = false;
                    }
                    _ => {}
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(format!("GPX XML parse error: {e}")),
            _ => {}
        }
        buf.clear();
    }

    if raw_points.len() < 2 {
        return Err("GPX must contain at least 2 track points".to_string());
    }
    Ok(raw_points)
}

/// Remplace les altitudes manquantes (`has_ele == false`) par interpolation
/// linéaire entre les points connus précédent et suivant les plus proches. Les
/// points manquants en tête et en queue reçoivent la valeur du premier / dernier
/// point connu (extrapolation constante, plus sûre que 0). Si aucun point n'a
/// d'altitude connue, tout reste à 0 — l'appelant se dégradera en douceur.
fn interpolate_missing_elevations(points: &mut [(f64, f64, f64, bool)]) {
    let n = points.len();
    if n == 0 {
        return;
    }
    // Sortie rapide : rien à interpoler.
    if points.iter().all(|p| p.3) {
        return;
    }
    // Aucune altitude du tout : on garde des zéros.
    if !points.iter().any(|p| p.3) {
        return;
    }

    // Indice de la première altitude connue — remplit en arrière les points manquants de tête.
    let first_known = points.iter().position(|p| p.3).unwrap();
    let first_ele = points[first_known].2;
    for p in &mut points[..first_known] {
        p.2 = first_ele;
        p.3 = true;
    }

    // Indice de la dernière altitude connue — remplit en avant les points manquants de queue.
    let last_known = points.iter().rposition(|p| p.3).unwrap();
    let last_ele = points[last_known].2;
    for p in &mut points[last_known + 1..] {
        p.2 = last_ele;
        p.3 = true;
    }

    // Interpole les trous entre points connus selon l'indice des points (assez
    // bon — la distance cumulée n'est pas encore calculée à ce stade).
    let mut i = first_known;
    while i < last_known {
        if !points[i + 1].3 {
            // Trouve le point connu suivant.
            let mut j = i + 2;
            while j <= last_known && !points[j].3 {
                j += 1;
            }
            let e0 = points[i].2;
            let e1 = points[j].2;
            let span = (j - i) as f64;
            for k in (i + 1)..j {
                let t = (k - i) as f64 / span;
                points[k].2 = e0 + (e1 - e0) * t;
                points[k].3 = true;
            }
            i = j;
        } else {
            i += 1;
        }
    }
}

fn read_lat_lon_attrs(e: &quick_xml::events::BytesStart<'_>, lat: &mut f64, lon: &mut f64) {
    for attr in e.attributes().flatten() {
        match attr.key.local_name().as_ref() {
            b"lat" => {
                let val = std::str::from_utf8(&attr.value).unwrap_or("0");
                *lat = val.parse().unwrap_or(0.0);
            }
            b"lon" => {
                let val = std::str::from_utf8(&attr.value).unwrap_or("0");
                *lon = val.parse().unwrap_or(0.0);
            }
            _ => {}
        }
    }
}

pub fn build_route(
    raw_points: Vec<(f64, f64, f64)>,
    max_route_points: usize,
    smooth_window_m: f64,
) -> Result<Route, String> {
    // Phase 1 : dédoublonnage selon la distance — retire les points trop proches
    let filtered = deduplicate_close_points(&raw_points);

    // Phase 2 : calcule les distances cumulées
    let n = filtered.len();
    let mut cumulative_distances = vec![0.0_f64; n];
    for i in 1..n {
        let d = haversine_distance(
            filtered[i - 1].0,
            filtered[i - 1].1,
            filtered[i].0,
            filtered[i].1,
        );
        cumulative_distances[i] = cumulative_distances[i - 1] + d;
    }

    let total_dist = cumulative_distances[n - 1];

    // Phase 2b : calcule la courbure (changement de cap par km) AVANT le sous-échantillonnage
    let curvatures = compute_curvatures(&filtered, &cumulative_distances);

    // Phase 3 : sous-échantillonnage adaptatif s'il y a trop de points
    let (filtered, cumulative_distances, curvatures) =
        if max_route_points > 0 && n > max_route_points {
            let (ds_pts, ds_dists) =
                downsample_route(&filtered, &cumulative_distances, max_route_points);
            // Recalcule la courbure sur les points sous-échantillonnés
            let ds_curvatures = compute_curvatures(&ds_pts, &ds_dists);
            (ds_pts, ds_dists, ds_curvatures)
        } else {
            (filtered, cumulative_distances, curvatures)
        };
    let n = filtered.len();

    // Phase 4 : lisse les altitudes — d'abord un filtre médian robuste pour
    // retirer les erreurs de DEM / GPS d'un seul échantillon, puis une
    // gaussienne fondée sur la distance pour la stabilité de la pente. Sans la
    // passe médiane, une erreur isolée de +500 m survit à la gaussienne et crée
    // un faux pic dans la pente et, en aval, la puissance / la vitesse.
    let raw_elevations: Vec<f64> = filtered.iter().map(|p| p.2).collect();
    let despiked = median_filter_elevations(&raw_elevations, MEDIAN_FILTER_WINDOW);
    let avg_spacing = if n > 1 { total_dist / (n - 1) as f64 } else { 10.0 };
    let smooth_window = smooth_window_m.max(avg_spacing * 3.0);
    let smoothed_elevations = smooth_elevations(&despiked, &cumulative_distances, smooth_window);

    // Phase 5 : construit les RoutePoints
    let mut points: Vec<RoutePoint> = Vec::with_capacity(n);
    let mut total_gain = 0.0;
    let mut total_loss = 0.0;

    for i in 0..n {
        let ele = smoothed_elevations[i];
        let segment_len = if i + 1 < n {
            cumulative_distances[i + 1] - cumulative_distances[i]
        } else {
            0.0
        };

        let grad = if i + 1 < n && segment_len > 0.5 {
            let ele_diff = smoothed_elevations[i + 1] - ele;
            if ele_diff > 0.0 {
                total_gain += ele_diff;
            } else {
                total_loss += ele_diff.abs();
            }
            gradient_pct(segment_len, ele_diff)
        } else {
            0.0
        };

        points.push(RoutePoint {
            lat: filtered[i].0,
            lon: filtered[i].1,
            elevation_m: ele,
            distance_m: cumulative_distances[i],
            gradient_pct: grad,
            segment_length_m: segment_len,
            curvature_deg_per_km: curvatures[i],
            surface_type: SurfaceType::Unknown,
        });
    }

    Ok(Route {
        total_distance_m: cumulative_distances[n - 1],
        total_elevation_gain_m: total_gain,
        total_elevation_loss_m: total_loss,
        points,
    })
}

/// Calcule le cap (degrés) du point A au point B.
fn bearing_deg(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    let lat1_r = lat1.to_radians();
    let lat2_r = lat2.to_radians();
    let dlon = (lon2 - lon1).to_radians();
    let y = dlon.sin() * lat2_r.cos();
    let x = lat1_r.cos() * lat2_r.sin() - lat1_r.sin() * lat2_r.cos() * dlon.cos();
    y.atan2(x).to_degrees().rem_euclid(360.0)
}

/// Calcule la courbure (degrés de changement de cap par km) de chaque point.
/// Méthode par triplets : changement de cap entre les segments (i-1→i) et (i→i+1).
fn compute_curvatures(points: &[(f64, f64, f64)], distances: &[f64]) -> Vec<f64> {
    let n = points.len();
    let mut curvatures = vec![0.0_f64; n];

    if n < 3 {
        return curvatures;
    }

    for i in 1..n - 1 {
        let b1 = bearing_deg(points[i - 1].0, points[i - 1].1, points[i].0, points[i].1);
        let b2 = bearing_deg(points[i].0, points[i].1, points[i + 1].0, points[i + 1].1);

        // Différence de cap signée, on prend la valeur absolue
        let mut delta = (b2 - b1).abs();
        if delta > 180.0 {
            delta = 360.0 - delta;
        }

        // Conversion en deg/km avec la distance locale du segment
        let seg_len = distances[i + 1] - distances[i - 1];
        let seg_km = seg_len / 1000.0;
        curvatures[i] = if seg_km > 0.001 {
            delta / seg_km
        } else {
            0.0
        };
    }

    // Propage les extrémités depuis le point intérieur le plus proche
    curvatures[0] = curvatures[1];
    curvatures[n - 1] = curvatures[n - 2];

    curvatures
}

/// Retire les points plus proches que MIN_POINT_SPACING_M pour réduire le bruit.
fn deduplicate_close_points(points: &[(f64, f64, f64)]) -> Vec<(f64, f64, f64)> {
    if points.len() < 2 {
        return points.to_vec();
    }

    let mut result = Vec::with_capacity(points.len());
    result.push(points[0]);

    for i in 1..points.len() {
        let last = result.last().unwrap();
        let dist = haversine_distance(last.0, last.1, points[i].0, points[i].1);
        if dist >= MIN_POINT_SPACING_M {
            result.push(points[i]);
        }
    }

    // Garde toujours le dernier point
    if result.last() != points.last() {
        if let Some(last) = points.last() {
            result.push(*last);
        }
    }

    result
}

/// Sous-échantillonne la route au nombre de points visé en préservant les reliefs.
/// Échantillonnage uniforme selon la distance qui garde départ / arrivée et espace régulièrement les points.
fn downsample_route(
    points: &[(f64, f64, f64)],
    distances: &[f64],
    target: usize,
) -> (Vec<(f64, f64, f64)>, Vec<f64>) {
    let n = points.len();
    if n <= target {
        return (points.to_vec(), distances.to_vec());
    }

    let total_dist = distances[n - 1];
    let step = total_dist / (target - 1) as f64;
    let mut result_pts = Vec::with_capacity(target);
    let mut result_dists = Vec::with_capacity(target);

    // Inclut toujours le premier point
    result_pts.push(points[0]);
    result_dists.push(distances[0]);

    let mut next_target_dist = step;
    let mut j = 1;

    for target_idx in 1..target - 1 {
        // Trouve le point le plus proche de next_target_dist
        while j < n - 1 && distances[j] < next_target_dist {
            j += 1;
        }

        // Prend le point le plus proche de la distance visée
        if j > 0 && (next_target_dist - distances[j - 1]).abs() < (distances[j] - next_target_dist).abs() {
            result_pts.push(points[j - 1]);
            result_dists.push(distances[j - 1]);
        } else {
            result_pts.push(points[j]);
            result_dists.push(distances[j]);
        }

        next_target_dist = (target_idx + 1) as f64 * step;
    }

    // Inclut toujours le dernier point
    result_pts.push(points[n - 1]);
    result_dists.push(distances[n - 1]);

    (result_pts, result_dists)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_simple_gpx() {
        let gpx = r#"<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="test">
  <trk>
    <trkseg>
      <trkpt lat="45.0" lon="6.0"><ele>500</ele></trkpt>
      <trkpt lat="45.001" lon="6.0"><ele>510</ele></trkpt>
      <trkpt lat="45.002" lon="6.0"><ele>520</ele></trkpt>
    </trkseg>
  </trk>
</gpx>"#;
        let route = parse_gpx(gpx.as_bytes(), None, None).unwrap();
        assert_eq!(route.points.len(), 3);
        assert!(route.total_distance_m > 100.0);
        assert!(route.total_elevation_gain_m > 0.0);
    }
}
