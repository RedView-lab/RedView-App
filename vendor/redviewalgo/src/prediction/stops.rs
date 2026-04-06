use crate::types::{StopEvent, StopStrategy, StopType};

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

#[cfg(test)]
mod tests {
    use super::*;
}
