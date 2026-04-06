pub mod geo;
pub mod interpolation;
pub mod physics;
pub mod statistics;

// Re-export commonly used items
pub use geo::haversine_distance;
pub use interpolation::{monotone_cubic_interp, smooth_elevations};
pub use physics::{
    air_density, altitude_acclimatization, altitude_power_factor, force_aero, force_aero_wind,
    force_gravity, force_rolling, gradient_adjusted_cda, gradient_pct,
    solve_speed_from_power_with_efficiency, terminal_velocity, DRIVETRAIN_EFFICIENCY, G,
};
pub use statistics::{
    fit_asymptotic_decay, fit_biexponential_decay, median, percentile, std_dev,
};
