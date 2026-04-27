const DEFAULT_FORECAST_POINT = { lat: 45.1885, lng: 5.7245 };
const DEFAULT_CLIMATE_POINT = { lat: 48.8566, lng: 2.3522 };

function parseArgs(argv) {
  const args = { baseUrl: process.env.OPENMETEO_UPSTREAM?.trim() || '' };
  for (let index = 2; index < argv.length; index += 1) {
    const part = argv[index];
    if (part === '--base-url') {
      args.baseUrl = (argv[index + 1] || '').trim();
      index += 1;
    }
  }
  return args;
}

function requireBaseUrl(baseUrl) {
  if (!baseUrl) {
    throw new Error('OPENMETEO_UPSTREAM is required. Pass --base-url http://<vps>:8080 or export OPENMETEO_UPSTREAM first.');
  }
  if (/api\.open-meteo\.com|climate-api\.open-meteo\.com/i.test(baseUrl)) {
    throw new Error(`Refusing public Open-Meteo endpoint: ${baseUrl}`);
  }
  return baseUrl.replace(/\/+$/, '');
}

function addHours(date, hours) {
  return new Date(date.getTime() + hours * 60 * 60 * 1000);
}

function toForecastIso(date) {
  const copy = new Date(date.getTime());
  copy.setMinutes(0, 0, 0);
  return copy.toISOString().slice(0, 13) + ':00';
}

function currentMonthRange() {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const start = new Date(Date.UTC(year, month, 1));
  const end = new Date(Date.UTC(year, month + 1, 0));
  const format = (value) => value.toISOString().slice(0, 10);
  return { start: format(start), end: format(end) };
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText} — ${text.slice(0, 240)}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON from ${url}: ${error instanceof Error ? error.message : String(error)} — ${text.slice(0, 240)}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function normaliseItems(json) {
  return Array.isArray(json) ? json : [json];
}

function validateForecastItem(item, index) {
  assert(item && typeof item === 'object', `Forecast item ${index} is missing`);
  const hourly = item.hourly;
  assert(hourly && typeof hourly === 'object', `Forecast item ${index} has no hourly payload`);
  const requiredKeys = [
    'temperature_2m',
    'relative_humidity_2m',
    'apparent_temperature',
    'precipitation',
    'cloud_cover',
  ];
  for (const key of requiredKeys) {
    assert(Array.isArray(hourly[key]), `Forecast item ${index} missing hourly.${key}`);
    assert(hourly[key].length > 0, `Forecast item ${index} has empty hourly.${key}`);
    assert(Number.isFinite(hourly[key][0]), `Forecast item ${index} has non-numeric hourly.${key}[0]`);
  }
}

function validateCurrentForecast(json) {
  assert(json && typeof json === 'object', 'Current forecast payload is missing');
  const current = json.current;
  assert(current && typeof current === 'object', 'Current forecast payload has no current block');
  const requiredKeys = [
    'temperature_2m',
    'apparent_temperature',
    'wind_speed_10m',
  ];
  for (const key of requiredKeys) {
    assert(Number.isFinite(current[key]), `Current forecast missing numeric current.${key}`);
  }
}

function validateClimateItem(item, index) {
  assert(item && typeof item === 'object', `Climate item ${index} is missing`);
  const daily = item.daily;
  assert(daily && typeof daily === 'object', `Climate item ${index} has no daily payload`);
  const requiredKeys = [
    'temperature_2m_mean',
    'relative_humidity_2m_mean',
    'cloud_cover_mean',
    'rain_sum',
    'precipitation_sum',
  ];
  for (const key of requiredKeys) {
    assert(Array.isArray(daily[key]), `Climate item ${index} missing daily.${key}`);
    assert(daily[key].length > 0, `Climate item ${index} has empty daily.${key}`);
    assert(Number.isFinite(daily[key][0]), `Climate item ${index} has non-numeric daily.${key}[0]`);
  }
}

async function main() {
  const { baseUrl } = parseArgs(process.argv);
  const upstream = requireBaseUrl(baseUrl);
  const forecastIso = toForecastIso(addHours(new Date(), 2));
  const { start, end } = currentMonthRange();

  const forecastUrl =
    `${upstream}/v1/forecast?latitude=${DEFAULT_FORECAST_POINT.lat},${DEFAULT_CLIMATE_POINT.lat}` +
    `&longitude=${DEFAULT_FORECAST_POINT.lng},${DEFAULT_CLIMATE_POINT.lng}` +
    '&hourly=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,cloud_cover' +
    `&start_hour=${encodeURIComponent(forecastIso)}&end_hour=${encodeURIComponent(forecastIso)}` +
    '&timezone=Europe%2FParis&temperature_unit=celsius&precipitation_unit=mm&cell_selection=nearest' +
    '&models=meteofrance_arome_france_hd';

  const currentForecastUrl =
    `${upstream}/v1/forecast?latitude=${DEFAULT_CLIMATE_POINT.lat}` +
    `&longitude=${DEFAULT_CLIMATE_POINT.lng}` +
    '&current=temperature_2m,apparent_temperature,wind_speed_10m';

  const climateUrl =
    `${upstream}/v1/climate?latitude=${DEFAULT_CLIMATE_POINT.lat},${DEFAULT_FORECAST_POINT.lat}` +
    `&longitude=${DEFAULT_CLIMATE_POINT.lng},${DEFAULT_FORECAST_POINT.lng}` +
    `&start_date=${start}&end_date=${end}` +
    '&models=MRI_AGCM3_2_S' +
    '&daily=temperature_2m_mean,relative_humidity_2m_mean,cloud_cover_mean,rain_sum,precipitation_sum' +
    '&timezone=Europe%2FParis&temperature_unit=celsius&precipitation_unit=mm&cell_selection=nearest';

  console.log(`[test-openmeteo-vps] forecast => ${forecastUrl}`);
  const forecastJson = await fetchJson(forecastUrl);
  const forecastItems = normaliseItems(forecastJson);
  assert(forecastItems.length === 2, `Expected 2 forecast items, got ${forecastItems.length}`);
  forecastItems.forEach(validateForecastItem);

  console.log(`[test-openmeteo-vps] current => ${currentForecastUrl}`);
  const currentForecastJson = await fetchJson(currentForecastUrl);
  validateCurrentForecast(currentForecastJson);

  console.log(`[test-openmeteo-vps] climate => ${climateUrl}`);
  const climateJson = await fetchJson(climateUrl);
  const climateItems = normaliseItems(climateJson);
  assert(climateItems.length === 2, `Expected 2 climate items, got ${climateItems.length}`);
  climateItems.forEach(validateClimateItem);

  console.log('[test-openmeteo-vps] OK');
  console.log(`[test-openmeteo-vps] current apparent_temperature sample = ${currentForecastJson.current.apparent_temperature}`);
  console.log(`[test-openmeteo-vps] forecast apparent_temperature sample = ${forecastItems[0].hourly.apparent_temperature[0]}`);
  console.log(`[test-openmeteo-vps] climate temperature_2m_mean sample = ${climateItems[0].daily.temperature_2m_mean[0]}`);
}

main().catch((error) => {
  console.error('[test-openmeteo-vps] FAILED');
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});