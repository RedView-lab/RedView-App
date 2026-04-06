use crate::types::{Route, StopEvent, StopStrategy, StopType};

/// Generate a schedule of stop events for integration into the prediction loop.
/// Returns a sorted list of `StopEvent` by riding time trigger.
pub fn generate_stop_schedule(
    estimated_riding_time_s: f64,
    strategy: &StopStrategy,
    has_sleep_stops: bool,
) -> Vec<StopEvent> {
    match strategy {
        StopStrategy::None => vec![],
        StopStrategy::Auto | StopStrategy::Ultra => {
            let mut events = Vec::new();
            let riding_h = estimated_riding_time_s / 3600.0;

            // Micro-stops: 8 min every 3h
            let n_micro = (riding_h / 3.0).floor() as u32;
            for i in 1..=n_micro {
                events.push(StopEvent {
                    riding_time_trigger_s: i as f64 * 3.0 * 3600.0,
                    duration_s: 480.0,
                    stop_type: StopType::Micro,
                });
            }

            // Extended stops: 20 min every 6h (replace overlapping micro-stops)
            let n_ext = (riding_h / 6.0).floor() as u32;
            for i in 1..=n_ext {
                let trigger = i as f64 * 6.0 * 3600.0;
                // Remove micro-stop at same time (extended replaces it)
                events.retain(|e| (e.riding_time_trigger_s - trigger).abs() > 60.0);
                events.push(StopEvent {
                    riding_time_trigger_s: trigger,
                    duration_s: 1200.0,
                    stop_type: StopType::Extended,
                });
            }

            // Sleep stops: 90 min every 20h
            if has_sleep_stops {
                let n_sleep = (riding_h / 20.0).floor() as u32;
                for i in 1..=n_sleep {
                    let trigger = i as f64 * 20.0 * 3600.0;
                    // Remove any stop within 1h of sleep stop
                    events.retain(|e| (e.riding_time_trigger_s - trigger).abs() > 3600.0);
                    events.push(StopEvent {
                        riding_time_trigger_s: trigger,
                        duration_s: 5400.0,
                        stop_type: StopType::Sleep,
                    });
                }
            }

            events.sort_by(|a, b| a.riding_time_trigger_s.partial_cmp(&b.riding_time_trigger_s).unwrap());
            events
        }
        StopStrategy::Custom { stop_min_per_hour } => {
            let mut events = Vec::new();
            let riding_h = estimated_riding_time_s / 3600.0;
            let stop_duration_s = stop_min_per_hour * 60.0;
            let n = riding_h.floor() as u32;
            for i in 1..=n {
                events.push(StopEvent {
                    riding_time_trigger_s: i as f64 * 3600.0,
                    duration_s: stop_duration_s,
                    stop_type: StopType::Micro,
                });
            }
            events
        }
    }
}

/// Shift stop times to prefer valley bottoms (low-gradient flat zones).
/// For each stop, search within ±10% of its trigger time for the flattest zone.
/// Avoids stopping mid-climb or mid-descent where it wastes momentum.
pub fn terrain_aware_shift(
    events: &mut [StopEvent],
    route: &Route,
    estimated_avg_speed_ms: f64,
) {
    if route.points.is_empty() || estimated_avg_speed_ms < 0.5 {
        return;
    }

    for event in events.iter_mut() {
        let trigger_dist = event.riding_time_trigger_s * estimated_avg_speed_ms;
        let search_radius = trigger_dist * 0.10; // ±10% of distance

        // Find the flattest point within search window
        let mut best_trigger = event.riding_time_trigger_s;
        let mut best_abs_gradient = f64::MAX;

        for rp in &route.points {
            if (rp.distance_m - trigger_dist).abs() > search_radius {
                continue;
            }
            let abs_g = rp.gradient_pct.abs();
            if abs_g < best_abs_gradient {
                best_abs_gradient = abs_g;
                // Convert distance back to time
                best_trigger = rp.distance_m / estimated_avg_speed_ms;
            }
        }

        event.riding_time_trigger_s = best_trigger;
    }

    // Re-sort after shifting
    events.sort_by(|a, b| {
        a.riding_time_trigger_s
            .partial_cmp(&b.riding_time_trigger_s)
            .unwrap()
    });
}

/// Adjust stop frequency for high-altitude sections.
/// Above 2500m, add extra micro-stops every 2h (instead of 3h) due to
/// increased physiological stress, dehydration, and decreased appetite.
pub fn altitude_adjusted_stops(
    events: &mut Vec<StopEvent>,
    route: &Route,
    estimated_avg_speed_ms: f64,
    estimated_riding_time_s: f64,
) {
    if route.points.is_empty() || estimated_avg_speed_ms < 0.5 {
        return;
    }

    // Find time ranges spent above 2500m
    let riding_h = estimated_riding_time_s / 3600.0;
    let mut high_alt_starts: Vec<f64> = Vec::new();
    let mut in_high = false;

    for rp in &route.points {
        let time_at_point = rp.distance_m / estimated_avg_speed_ms;
        if rp.elevation_m > 2500.0 && !in_high {
            in_high = true;
            high_alt_starts.push(time_at_point);
        } else if rp.elevation_m <= 2500.0 {
            in_high = false;
        }
    }

    // Add extra micro-stops every 2h during high-altitude sections
    for &start_s in &high_alt_starts {
        let mut t = start_s + 7200.0; // first extra stop after 2h at altitude
        while t < estimated_riding_time_s {
            // Only add if no existing stop within 30min
            let has_nearby = events
                .iter()
                .any(|e| (e.riding_time_trigger_s - t).abs() < 1800.0);
            if !has_nearby {
                events.push(StopEvent {
                    riding_time_trigger_s: t,
                    duration_s: 480.0,
                    stop_type: StopType::Micro,
                });
            }
            t += 7200.0;
            // Stop adding once we're past estimated time
            if t / 3600.0 > riding_h {
                break;
            }
        }
    }

    events.sort_by(|a, b| {
        a.riding_time_trigger_s
            .partial_cmp(&b.riding_time_trigger_s)
            .unwrap()
    });
}
