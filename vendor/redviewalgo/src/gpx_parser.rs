use crate::math::{gradient_pct, haversine_distance, smooth_elevations};
use crate::types::{Route, RoutePoint, SurfaceType};
use quick_xml::events::Event;
use quick_xml::Reader;

/// Default maximum route points for prediction.
const DEFAULT_MAX_ROUTE_POINTS: usize = 15_000;

/// Minimum distance between consecutive points (metres).
const MIN_POINT_SPACING_M: f64 = 5.0;

/// Default smoothing window in metres.
const DEFAULT_SMOOTH_WINDOW_M: f64 = 50.0;

/// Parse a GPX file from raw bytes into a `Route`.
/// `max_points` controls downsampling (None = use default 15000).
/// `smooth_window_m` controls elevation smoothing (None = use default 50m).
pub fn parse_gpx(
    data: &[u8],
    max_points: Option<usize>,
    smooth_window_m: Option<f64>,
) -> Result<Route, String> {
    let xml = std::str::from_utf8(data).map_err(|e| format!("GPX is not valid UTF-8: {e}"))?;

    // Pre-allocate based on estimated point count (~1 point per 80 bytes of GPX)
    let estimated_points = data.len() / 80;
    let mut reader = Reader::from_str(xml);
    let mut raw_points: Vec<(f64, f64, f64)> = Vec::with_capacity(estimated_points.min(500_000));
    let mut in_trkpt = false;
    let mut in_ele = false;
    let mut current_lat: f64 = 0.0;
    let mut current_lon: f64 = 0.0;
    let mut current_ele: f64 = 0.0;
    let mut buf = Vec::with_capacity(256);

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) => {
                let local_name = e.local_name();
                match local_name.as_ref() {
                    b"trkpt" | b"rtept" => {
                        in_trkpt = true;
                        current_ele = 0.0;
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
                    // Self-closing <trkpt lat="..." lon="..." /> — no elevation child
                    let mut lat = 0.0;
                    let mut lon = 0.0;
                    read_lat_lon_attrs(e, &mut lat, &mut lon);
                    raw_points.push((lat, lon, 0.0));
                }
            }
            Ok(Event::Text(ref e)) if in_ele => {
                let txt = e.unescape().unwrap_or_default();
                current_ele = txt.trim().parse().unwrap_or(0.0);
            }
            Ok(Event::End(ref e)) => {
                let local_name = e.local_name();
                match local_name.as_ref() {
                    b"trkpt" | b"rtept" => {
                        if in_trkpt {
                            raw_points.push((current_lat, current_lon, current_ele));
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

    let max_pts = max_points.unwrap_or(DEFAULT_MAX_ROUTE_POINTS);
    let smooth_w = smooth_window_m.unwrap_or(DEFAULT_SMOOTH_WINDOW_M);
    build_route(raw_points, max_pts, smooth_w)
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
    // Phase 1: Distance-based deduplication — remove points too close together
    let filtered = deduplicate_close_points(&raw_points);

    // Phase 2: Compute cumulative distances
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

    // Phase 2b: Compute curvature (bearing change per km) BEFORE downsampling
    let curvatures = compute_curvatures(&filtered, &cumulative_distances);

    // Phase 3: Adaptive downsampling if too many points
    let (filtered, cumulative_distances, curvatures) =
        if max_route_points > 0 && n > max_route_points {
            let (ds_pts, ds_dists) =
                downsample_route(&filtered, &cumulative_distances, max_route_points);
            // Re-compute curvature on downsampled points
            let ds_curvatures = compute_curvatures(&ds_pts, &ds_dists);
            (ds_pts, ds_dists, ds_curvatures)
        } else {
            (filtered, cumulative_distances, curvatures)
        };
    let n = filtered.len();

    // Phase 4: Smooth elevations — adaptive window based on point density
    let raw_elevations: Vec<f64> = filtered.iter().map(|p| p.2).collect();
    let avg_spacing = if n > 1 { total_dist / (n - 1) as f64 } else { 10.0 };
    let smooth_window = smooth_window_m.max(avg_spacing * 3.0);
    let smoothed_elevations = smooth_elevations(&raw_elevations, &cumulative_distances, smooth_window);

    // Phase 5: Build RoutePoints
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

/// Compute bearing (degrees) from point A to point B.
fn bearing_deg(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    let lat1_r = lat1.to_radians();
    let lat2_r = lat2.to_radians();
    let dlon = (lon2 - lon1).to_radians();
    let y = dlon.sin() * lat2_r.cos();
    let x = lat1_r.cos() * lat2_r.sin() - lat1_r.sin() * lat2_r.cos() * dlon.cos();
    y.atan2(x).to_degrees().rem_euclid(360.0)
}

/// Compute curvature (degrees of bearing change per km) for each point.
/// Uses a triplet approach: bearing change between segments (i-1→i) and (i→i+1).
fn compute_curvatures(points: &[(f64, f64, f64)], distances: &[f64]) -> Vec<f64> {
    let n = points.len();
    let mut curvatures = vec![0.0_f64; n];

    if n < 3 {
        return curvatures;
    }

    for i in 1..n - 1 {
        let b1 = bearing_deg(points[i - 1].0, points[i - 1].1, points[i].0, points[i].1);
        let b2 = bearing_deg(points[i].0, points[i].1, points[i + 1].0, points[i + 1].1);

        // Signed bearing difference, take absolute value
        let mut delta = (b2 - b1).abs();
        if delta > 180.0 {
            delta = 360.0 - delta;
        }

        // Convert to deg/km using local segment distance
        let seg_len = distances[i + 1] - distances[i - 1];
        let seg_km = seg_len / 1000.0;
        curvatures[i] = if seg_km > 0.001 {
            delta / seg_km
        } else {
            0.0
        };
    }

    // Propagate endpoints from nearest interior point
    curvatures[0] = curvatures[1];
    curvatures[n - 1] = curvatures[n - 2];

    curvatures
}

/// Remove points that are closer than MIN_POINT_SPACING_M to reduce noise.
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

    // Always keep the last point
    if result.last() != points.last() {
        if let Some(last) = points.last() {
            result.push(*last);
        }
    }

    result
}

/// Downsample route to target number of points while preserving elevation features.
/// Uses a distance-based uniform sampling that keeps start/end and evenly spaces points.
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

    // Always include first point
    result_pts.push(points[0]);
    result_dists.push(distances[0]);

    let mut next_target_dist = step;
    let mut j = 1;

    for target_idx in 1..target - 1 {
        // Find the point closest to next_target_dist
        while j < n - 1 && distances[j] < next_target_dist {
            j += 1;
        }

        // Pick the point closest to the target distance
        if j > 0 && (next_target_dist - distances[j - 1]).abs() < (distances[j] - next_target_dist).abs() {
            result_pts.push(points[j - 1]);
            result_dists.push(distances[j - 1]);
        } else {
            result_pts.push(points[j]);
            result_dists.push(distances[j]);
        }

        next_target_dist = (target_idx + 1) as f64 * step;
    }

    // Always include last point
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
