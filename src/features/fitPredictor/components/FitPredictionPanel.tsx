import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, CSSProperties } from 'react';
import { createFitPredictionEngine } from '../engine/api';
import type {
  ComparisonResult,
  FitPanelMode,
  PredictionConfig,
  PredictionResult,
} from '../types';

interface FitPredictionPanelProps {
  open: boolean;
  onToggleOpen: () => void;
}

export function FitPredictionPanel({ open, onToggleOpen }: FitPredictionPanelProps) {
  const engineRef = useRef<ReturnType<typeof createFitPredictionEngine> | null>(null);
  const fitInputRef = useRef<HTMLInputElement | null>(null);
  const gpxInputRef = useRef<HTMLInputElement | null>(null);
  const validationInputRef = useRef<HTMLInputElement | null>(null);
  const [mode, setMode] = useState<FitPanelMode>('route');
  const [fitFiles, setFitFiles] = useState<File[]>([]);
  const [gpxFile, setGpxFile] = useState<File | null>(null);
  const [validationFile, setValidationFile] = useState<File | null>(null);
  const [massKg, setMassKg] = useState('');
  const [pacingFactor, setPacingFactor] = useState('1.0');
  const [busy, setBusy] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [predictionResult, setPredictionResult] = useState<PredictionResult | null>(null);
  const [comparisonResult, setComparisonResult] = useState<ComparisonResult | null>(null);

  useEffect(() => {
    const engine = createFitPredictionEngine();
    engineRef.current = engine;

    return () => {
      engine.terminate();
      engineRef.current = null;
    };
  }, []);

  useEffect(() => {
    setError(null);
    setPredictionResult(null);
    setComparisonResult(null);
    setLogs([]);
  }, [mode]);

  const hasResult = Boolean(predictionResult || comparisonResult);
  const panelVisible = open || busy || Boolean(error) || hasResult;
  const canRunRoute = fitFiles.length > 0 && Boolean(gpxFile) && !busy;
  const canRunCompare = fitFiles.length > 0 && Boolean(validationFile) && !busy;
  const canRun = mode === 'route' ? canRunRoute : canRunCompare;

  const handleFitChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files ? Array.from(event.target.files) : [];
    setFitFiles(files);
    resetOutputs();
  };

  const handleGpxChange = (event: ChangeEvent<HTMLInputElement>) => {
    setGpxFile(event.target.files?.[0] ?? null);
    resetOutputs();
  };

  const handleValidationChange = (event: ChangeEvent<HTMLInputElement>) => {
    setValidationFile(event.target.files?.[0] ?? null);
    resetOutputs();
  };

  const handleClear = () => {
    setFitFiles([]);
    setGpxFile(null);
    setValidationFile(null);
    setMassKg('');
    setPacingFactor('1.0');
    resetOutputs();

    if (fitInputRef.current) {
      fitInputRef.current.value = '';
    }
    if (gpxInputRef.current) {
      gpxInputRef.current.value = '';
    }
    if (validationInputRef.current) {
      validationInputRef.current.value = '';
    }
  };

  const handleRun = async () => {
    if (!engineRef.current || !canRun) {
      return;
    }

    const config = buildConfig(massKg, pacingFactor);
    setBusy(true);
    setError(null);
    setPredictionResult(null);
    setComparisonResult(null);
    setLogs([]);

    try {
      if (mode === 'route' && gpxFile) {
        const result = await engineRef.current.predict(fitFiles, gpxFile, config, (message) => {
          setLogs((current) => {
            const next = [...current, message];
            return next.length > 60 ? next.slice(-60) : next;
          });
        });
        setPredictionResult(result);
      }

      if (mode === 'compare' && validationFile) {
        const result = await engineRef.current.compare(fitFiles, validationFile, config);
        setComparisonResult(result);
      }
    } catch (runError: unknown) {
      setError(runError instanceof Error ? runError.message : String(runError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={dockStyle}>
      <div style={toolbarStyle}>
        <button onClick={onToggleOpen} style={{ ...modeButtonStyle, ...(open ? modeButtonActiveStyle : null) }}>
          {open ? 'Predict on' : 'Predict'}
        </button>
        {(fitFiles.length > 0 || gpxFile || validationFile || hasResult || error) && (
          <button type="button" onClick={handleClear} style={secondaryButtonStyle}>
            Reset
          </button>
        )}
        {busy && <div style={statusChipStyle}>Calcul</div>}
        {!busy && comparisonResult && <div style={successChipStyle}>Compare</div>}
        {!busy && predictionResult && <div style={successChipStyle}>Route</div>}
        {error && <div style={errorChipStyle}>Erreur</div>}
      </div>

      {panelVisible && (
        <div style={panelStyle}>
          <div style={summaryRowStyle}>
            <div style={summaryCardStyle}>
              <span style={summaryLabelStyle}>Mode</span>
              <strong style={summaryValueStyle}>{mode === 'route' ? 'FIT + GPX' : 'Temps reel'}</strong>
            </div>
            <div style={summaryCardStyle}>
              <span style={summaryLabelStyle}>Historique</span>
              <strong style={summaryValueStyle}>{fitFiles.length > 0 ? `${fitFiles.length} FIT` : 'Aucun'}</strong>
            </div>
            <div style={summaryCardStyle}>
              <span style={summaryLabelStyle}>Local</span>
              <strong style={summaryValueStyle}>100% client</strong>
            </div>
          </div>

          <div style={segmentedStyle}>
            <button
              type="button"
              onClick={() => setMode('route')}
              style={{ ...segmentButtonStyle, ...(mode === 'route' ? segmentButtonActiveStyle : null) }}
            >
              Prediction GPX
            </button>
            <button
              type="button"
              onClick={() => setMode('compare')}
              style={{ ...segmentButtonStyle, ...(mode === 'compare' ? segmentButtonActiveStyle : null) }}
            >
              Predit vs reel
            </button>
          </div>

          <div style={cardStyle}>
            <label style={fieldLabelStyle}>Fichiers FIT historiques</label>
            <input
              ref={fitInputRef}
              type="file"
              accept=".fit"
              multiple
              onChange={handleFitChange}
              style={fileInputStyle}
            />
            <p style={fieldMetaStyle}>{formatFitSummary(fitFiles)}</p>
          </div>

          {mode === 'route' ? (
            <div style={cardStyle}>
              <label style={fieldLabelStyle}>Trace GPX cible</label>
              <input
                ref={gpxInputRef}
                type="file"
                accept=".gpx"
                onChange={handleGpxChange}
                style={fileInputStyle}
              />
              <p style={fieldMetaStyle}>{gpxFile ? gpxFile.name : 'Aucun GPX charge'}</p>
            </div>
          ) : (
            <div style={cardStyle}>
              <label style={fieldLabelStyle}>FIT reel de validation</label>
              <input
                ref={validationInputRef}
                type="file"
                accept=".fit"
                onChange={handleValidationChange}
                style={fileInputStyle}
              />
              <p style={fieldMetaStyle}>
                {validationFile
                  ? `${validationFile.name} utilise la trace reelle hors entrainement`
                  : 'Le FIT reel sert de route et de temps observe'}
              </p>
            </div>
          )}

          <div style={configGridStyle}>
            <div style={configFieldStyle}>
              <label style={fieldLabelStyle}>Poids total (kg)</label>
              <input
                type="number"
                min="40"
                max="200"
                step="0.5"
                value={massKg}
                onChange={(event) => setMassKg(event.target.value)}
                placeholder="auto"
                style={textInputStyle}
              />
            </div>
            <div style={configFieldStyle}>
              <label style={fieldLabelStyle}>Pacing</label>
              <select value={pacingFactor} onChange={(event) => setPacingFactor(event.target.value)} style={textInputStyle}>
                <option value="0.85">Conservateur</option>
                <option value="1.0">Normal</option>
                <option value="1.1">Agressif</option>
              </select>
            </div>
          </div>

          <div style={hintStyle}>
            {mode === 'route'
              ? 'Charge plusieurs FIT pour profiler le rider puis un GPX pour estimer le temps.'
              : 'Charge plusieurs FIT d historique puis un FIT reel separe pour comparer temps predit vs temps observe.'}
          </div>

          {error && <div style={errorStyle}>{error}</div>}

          <button type="button" onClick={handleRun} disabled={!canRun} style={{ ...runButtonStyle, ...(canRun ? null : runButtonDisabledStyle) }}>
            {busy ? 'Calcul en cours...' : mode === 'route' ? 'Lancer prediction' : 'Comparer'}
          </button>

          {busy && mode === 'route' && logs.length > 0 && (
            <div style={cardStyle}>
              <div style={cardHeaderStyle}>
                <span style={sectionTitleStyle}>Progression</span>
                <span style={mutedTextStyle}>{logs.length} etapes</span>
              </div>
              <div style={logListStyle}>
                {logs.map((line, index) => (
                  <div key={`${index}-${line}`} style={logLineStyle}>
                    {line}
                  </div>
                ))}
              </div>
            </div>
          )}

          {predictionResult && (
            <div style={cardStyle}>
              <div style={cardHeaderStyle}>
                <span style={sectionTitleStyle}>Resultat</span>
                <span style={mutedTextStyle}>Prediction route</span>
              </div>
              <div style={metricsGridStyle}>
                <Metric label="Temps predit" value={formatDuration(predictionResult.total_time_s)} accent />
                <Metric label="Temps roule" value={formatDuration(predictionResult.riding_time_s)} />
                <Metric label="Temps d arret" value={formatDuration(predictionResult.stop_time_s)} />
                <Metric label="Distance" value={`${(predictionResult.total_distance_m / 1000).toFixed(1)} km`} />
                <Metric label="Vitesse moy" value={`${predictionResult.avg_speed_kmh.toFixed(1)} km/h`} />
                <Metric label="D+ / D-" value={`${Math.round(predictionResult.elevation_gain_m)} / ${Math.round(predictionResult.elevation_loss_m)} m`} />
                <Metric label="FTP" value={predictionResult.rider_profile.ftp_w > 0 ? `${Math.round(predictionResult.rider_profile.ftp_w)} W` : 'N/A'} />
                <Metric label="Masse rider" value={`${predictionResult.rider_profile.mass_kg.toFixed(1)} kg`} />
              </div>
            </div>
          )}

          {comparisonResult && (
            <div style={cardStyle}>
              <div style={cardHeaderStyle}>
                <span style={sectionTitleStyle}>Comparaison</span>
                <span style={mutedTextStyle}>Temps trouve vs temps reel</span>
              </div>
              <div style={metricsGridStyle}>
                <Metric label="Temps predit" value={formatDuration(comparisonResult.prediction.total_time_s)} accent />
                <Metric label="Temps reel" value={formatDuration(comparisonResult.actual_total_time_s)} />
                <Metric label="Ecart" value={formatSignedDuration(comparisonResult.prediction.total_time_s - comparisonResult.actual_total_time_s)} />
                <Metric label="Erreur" value={formatPercent(comparisonResult.prediction.total_time_s, comparisonResult.actual_total_time_s)} />
                <Metric label="Distance" value={`${(comparisonResult.actual_distance_m / 1000).toFixed(1)} km`} />
                <Metric label="Vit. predite" value={`${comparisonResult.prediction.avg_speed_kmh.toFixed(1)} km/h`} />
                <Metric label="Vit. reelle" value={`${comparisonResult.actual_avg_speed_kmh.toFixed(1)} km/h`} />
                <Metric label="Temps roule reel" value={formatDuration(comparisonResult.actual_riding_time_s)} />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );

  function resetOutputs() {
    setError(null);
    setPredictionResult(null);
    setComparisonResult(null);
    setLogs([]);
  }
}

function Metric({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div style={metricCardStyle}>
      <span style={metricLabelStyle}>{label}</span>
      <strong style={{ ...metricValueStyle, ...(accent ? metricAccentStyle : null) }}>{value}</strong>
    </div>
  );
}

function buildConfig(massKg: string, pacingFactor: string): PredictionConfig {
  const config: PredictionConfig = {
    pacing_factor: Number.parseFloat(pacingFactor),
  };
  const parsedMass = Number.parseFloat(massKg);
  if (!Number.isNaN(parsedMass) && parsedMass > 0) {
    config.mass_kg = parsedMass;
  }
  return config;
}

function formatFitSummary(files: readonly File[]): string {
  if (files.length === 0) {
    return 'Aucun FIT charge';
  }
  if (files.length === 1) {
    return files[0].name;
  }
  const preview = files.slice(0, 2).map((file) => file.name).join(', ');
  return files.length > 2 ? `${files.length} fichiers · ${preview}...` : `${files.length} fichiers · ${preview}`;
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return '0m';
  }
  const totalSeconds = Math.round(seconds);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, '0')}m ${String(secs).padStart(2, '0')}s`;
  }
  return `${minutes}m ${String(secs).padStart(2, '0')}s`;
}

function formatSignedDuration(seconds: number): string {
  const sign = seconds > 0 ? '+' : seconds < 0 ? '-' : '';
  return `${sign}${formatDuration(Math.abs(seconds))}`;
}

function formatPercent(predicted: number, actual: number): string {
  if (!Number.isFinite(predicted) || !Number.isFinite(actual) || actual <= 0) {
    return 'N/A';
  }
  const delta = ((predicted - actual) / actual) * 100;
  return `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%`;
}

const dockStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  fontFamily: 'system-ui, sans-serif',
};

const toolbarStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  flexWrap: 'wrap',
};

const modeButtonStyle: CSSProperties = {
  background: 'rgba(12, 16, 24, 0.8)',
  color: 'rgba(255,255,255,0.92)',
  border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 999,
  padding: '8px 12px',
  fontSize: 12,
  cursor: 'pointer',
  backdropFilter: 'blur(16px)',
};

const modeButtonActiveStyle: CSSProperties = {
  background: 'rgba(167, 87, 22, 0.92)',
  borderColor: 'rgba(245, 158, 11, 0.42)',
};

const secondaryButtonStyle: CSSProperties = {
  background: 'rgba(12, 16, 24, 0.62)',
  color: 'rgba(255,255,255,0.78)',
  border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: 999,
  padding: '8px 11px',
  fontSize: 11,
  cursor: 'pointer',
  backdropFilter: 'blur(16px)',
};

const statusChipStyle: CSSProperties = {
  padding: '7px 10px',
  borderRadius: 999,
  background: 'rgba(40, 30, 18, 0.9)',
  border: '1px solid rgba(245, 158, 11, 0.24)',
  color: '#fde7c2',
  fontSize: 11,
};

const successChipStyle: CSSProperties = {
  padding: '7px 10px',
  borderRadius: 999,
  background: 'rgba(18, 40, 30, 0.82)',
  border: '1px solid rgba(74, 222, 128, 0.24)',
  color: '#d5ffe0',
  fontSize: 11,
};

const errorChipStyle: CSSProperties = {
  padding: '7px 10px',
  borderRadius: 999,
  background: 'rgba(78, 14, 14, 0.85)',
  border: '1px solid rgba(248,113,113,0.24)',
  color: '#ffd3d3',
  fontSize: 11,
};

const panelStyle: CSSProperties = {
  width: 'min(340px, calc(100vw - 24px))',
  padding: 12,
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  background: 'rgba(12, 14, 20, 0.84)',
  border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: 16,
  backdropFilter: 'blur(18px)',
  boxShadow: '0 18px 48px rgba(0,0,0,0.36)',
};

const summaryRowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
  gap: 6,
};

const summaryCardStyle: CSSProperties = {
  padding: '8px 9px',
  borderRadius: 12,
  background: 'rgba(255,255,255,0.035)',
  border: '1px solid rgba(255,255,255,0.06)',
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
};

const summaryLabelStyle: CSSProperties = {
  fontSize: 9,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  color: '#8d97a7',
};

const summaryValueStyle: CSSProperties = {
  fontSize: 11,
  color: '#f4f7fb',
  fontWeight: 600,
};

const segmentedStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: 6,
};

const segmentButtonStyle: CSSProperties = {
  borderRadius: 10,
  border: '1px solid rgba(255,255,255,0.08)',
  background: 'rgba(255,255,255,0.03)',
  color: '#cfd6e4',
  fontSize: 11,
  padding: '8px 10px',
  cursor: 'pointer',
};

const segmentButtonActiveStyle: CSSProperties = {
  background: 'rgba(245, 158, 11, 0.14)',
  borderColor: 'rgba(245, 158, 11, 0.3)',
  color: '#fff4d8',
};

const cardStyle: CSSProperties = {
  padding: 10,
  background: 'rgba(255,255,255,0.035)',
  borderRadius: 12,
  border: '1px solid rgba(255,255,255,0.06)',
};

const fieldLabelStyle: CSSProperties = {
  display: 'block',
  fontSize: 10,
  color: '#b7c1d4',
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  fontWeight: 500,
  marginBottom: 8,
};

const fileInputStyle: CSSProperties = {
  width: '100%',
  color: '#dbe3f0',
  fontSize: 11,
};

const fieldMetaStyle: CSSProperties = {
  margin: '8px 0 0',
  fontSize: 10,
  color: '#97a3b8',
  lineHeight: 1.45,
};

const configGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  gap: 8,
};

const configFieldStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 0,
};

const textInputStyle: CSSProperties = {
  width: '100%',
  borderRadius: 10,
  border: '1px solid rgba(255,255,255,0.1)',
  background: 'rgba(6, 9, 15, 0.55)',
  color: '#f3f6fc',
  fontSize: 12,
  padding: '9px 10px',
  outline: 'none',
};

const hintStyle: CSSProperties = {
  fontSize: 10,
  color: '#b6becf',
  lineHeight: 1.5,
  padding: '0 2px',
};

const errorStyle: CSSProperties = {
  padding: 8,
  background: 'rgba(220,38,38,0.16)',
  borderRadius: 12,
  border: '1px solid rgba(220,38,38,0.26)',
  fontSize: 11,
  color: '#fecaca',
  lineHeight: 1.45,
};

const runButtonStyle: CSSProperties = {
  borderRadius: 12,
  border: '1px solid rgba(245, 158, 11, 0.28)',
  background: 'linear-gradient(135deg, rgba(180, 83, 9, 0.94), rgba(249, 115, 22, 0.92))',
  color: '#fff8ef',
  fontSize: 12,
  fontWeight: 600,
  padding: '10px 12px',
  cursor: 'pointer',
};

const runButtonDisabledStyle: CSSProperties = {
  cursor: 'not-allowed',
  opacity: 0.45,
};

const cardHeaderStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: 8,
  marginBottom: 8,
};

const sectionTitleStyle: CSSProperties = {
  fontSize: 10,
  color: '#b7c1d4',
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  fontWeight: 500,
};

const mutedTextStyle: CSSProperties = {
  fontSize: 10,
  color: '#8d97a7',
};

const logListStyle: CSSProperties = {
  maxHeight: 140,
  overflowY: 'auto',
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
};

const logLineStyle: CSSProperties = {
  fontSize: 10,
  color: '#d5dde9',
  lineHeight: 1.45,
  padding: '6px 8px',
  borderRadius: 8,
  background: 'rgba(255,255,255,0.025)',
};

const metricsGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  gap: 8,
};

const metricCardStyle: CSSProperties = {
  padding: '9px 10px',
  borderRadius: 12,
  background: 'rgba(255,255,255,0.03)',
  border: '1px solid rgba(255,255,255,0.06)',
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
};

const metricLabelStyle: CSSProperties = {
  fontSize: 9,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  color: '#90a0b7',
};

const metricValueStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  color: '#f8fafc',
};

const metricAccentStyle: CSSProperties = {
  color: '#ffd89a',
};