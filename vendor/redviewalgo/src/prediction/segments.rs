use crate::types::{PredictionPoint, RoutePoint, SegmentSummary};

/// Classify terrain and group consecutive points into meaningful segments.
pub fn build_segments(
    pred_points: &[PredictionPoint],
    _route_points: &[RoutePoint],
) -> Vec<SegmentSummary> {
    if pred_points.len() < 2 {
        return vec![];
    }

    let mut segments: Vec<SegmentSummary> = Vec::new();
    let mut seg_start = 0;
    let mut current_type = classify_gradient(pred_points[0].gradient_pct);

    for i in 1..pred_points.len() {
        let point_type = classify_gradient(pred_points[i].gradient_pct);

        let distance_in_seg = pred_points[i].distance_m - pred_points[seg_start].distance_m;
        let type_changed = point_type != current_type && distance_in_seg > 500.0;
        let too_long = distance_in_seg > 10_000.0;

        if type_changed || too_long || i == pred_points.len() - 1 {
            let end_idx = if i == pred_points.len() - 1 { i } else { i - 1 };
            if end_idx > seg_start {
                let seg = build_one_segment(pred_points, seg_start, end_idx);
                segments.push(seg);
            }
            seg_start = i;
            current_type = point_type;
        }
    }

    segments
}

fn classify_gradient(gradient_pct: f64) -> &'static str {
    if gradient_pct > 2.0 {
        "climb"
    } else if gradient_pct < -2.0 {
        "descent"
    } else {
        "flat"
    }
}

fn build_one_segment(
    pred: &[PredictionPoint],
    start: usize,
    end: usize,
) -> SegmentSummary {
    let start_dist = pred[start].distance_m;
    let end_dist = pred[end].distance_m;
    let distance = end_dist - start_dist;

    let mut gain = 0.0;
    let mut loss = 0.0;
    for i in (start + 1)..=end {
        let diff = pred[i].elevation_m - pred[i - 1].elevation_m;
        if diff > 0.0 {
            gain += diff;
        } else {
            loss += diff.abs();
        }
    }

    let time_s =
        pred[end].elapsed_time_s - pred[start].elapsed_time_s + pred[end].segment_time_s;

    let avg_gradient: f64 = if end > start {
        pred[start..=end]
            .iter()
            .map(|p| p.gradient_pct)
            .sum::<f64>()
            / (end - start + 1) as f64
    } else {
        0.0
    };

    let avg_speed_kmh = if time_s > 0.0 {
        (distance / time_s) * 3.6
    } else {
        0.0
    };

    let seg_type = classify_gradient(avg_gradient).to_string();

    // VAM (Velocità Ascensionale Media): vertical ascent rate in m/h
    // Only meaningful for climb segments
    let vam_mh = if seg_type == "climb" && time_s > 0.0 && gain > 0.0 {
        gain / (time_s / 3600.0)
    } else {
        0.0
    };

    SegmentSummary {
        start_distance_m: start_dist,
        end_distance_m: end_dist,
        distance_m: distance,
        elevation_gain_m: gain,
        elevation_loss_m: loss,
        avg_gradient_pct: avg_gradient,
        avg_speed_kmh,
        time_s,
        segment_type: seg_type,
        vam_mh,
    }
}
