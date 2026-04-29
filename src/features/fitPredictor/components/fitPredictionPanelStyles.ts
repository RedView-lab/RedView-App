import type { CSSProperties } from 'react';

export const dockStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  fontFamily: 'system-ui, sans-serif',
};

export const toolbarStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  flexWrap: 'wrap',
};

export const modeButtonStyle: CSSProperties = {
  background: 'rgba(12, 16, 24, 0.8)',
  color: 'rgba(255,255,255,0.92)',
  border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 999,
  padding: '8px 12px',
  fontSize: 12,
  cursor: 'pointer',
  backdropFilter: 'blur(16px)',
};

export const modeButtonActiveStyle: CSSProperties = {
  background: 'rgba(167, 87, 22, 0.92)',
  borderColor: 'rgba(245, 158, 11, 0.42)',
};

export const secondaryButtonStyle: CSSProperties = {
  background: 'rgba(12, 16, 24, 0.62)',
  color: 'rgba(255,255,255,0.78)',
  border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: 999,
  padding: '8px 11px',
  fontSize: 11,
  cursor: 'pointer',
  backdropFilter: 'blur(16px)',
};

export const statusChipStyle: CSSProperties = {
  padding: '7px 10px',
  borderRadius: 999,
  background: 'rgba(40, 30, 18, 0.9)',
  border: '1px solid rgba(245, 158, 11, 0.24)',
  color: '#fde7c2',
  fontSize: 11,
};

export const successChipStyle: CSSProperties = {
  padding: '7px 10px',
  borderRadius: 999,
  background: 'rgba(18, 40, 30, 0.82)',
  border: '1px solid rgba(74, 222, 128, 0.24)',
  color: '#d5ffe0',
  fontSize: 11,
};

export const errorChipStyle: CSSProperties = {
  padding: '7px 10px',
  borderRadius: 999,
  background: 'rgba(78, 14, 14, 0.85)',
  border: '1px solid rgba(248,113,113,0.24)',
  color: '#ffd3d3',
  fontSize: 11,
};

export const panelStyle: CSSProperties = {
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

export const summaryRowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
  gap: 6,
};

export const summaryCardStyle: CSSProperties = {
  padding: '8px 9px',
  borderRadius: 12,
  background: 'rgba(255,255,255,0.035)',
  border: '1px solid rgba(255,255,255,0.06)',
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
};

export const summaryLabelStyle: CSSProperties = {
  fontSize: 9,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  color: '#8d97a7',
};

export const summaryValueStyle: CSSProperties = {
  fontSize: 11,
  color: '#f4f7fb',
  fontWeight: 600,
};

export const segmentedStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: 6,
};

export const segmentButtonStyle: CSSProperties = {
  borderRadius: 10,
  border: '1px solid rgba(255,255,255,0.08)',
  background: 'rgba(255,255,255,0.03)',
  color: '#cfd6e4',
  fontSize: 11,
  padding: '8px 10px',
  cursor: 'pointer',
};

export const segmentButtonActiveStyle: CSSProperties = {
  background: 'rgba(245, 158, 11, 0.14)',
  borderColor: 'rgba(245, 158, 11, 0.3)',
  color: '#fff4d8',
};

export const cardStyle: CSSProperties = {
  padding: 10,
  background: 'rgba(255,255,255,0.035)',
  borderRadius: 12,
  border: '1px solid rgba(255,255,255,0.06)',
};

export const fieldLabelStyle: CSSProperties = {
  display: 'block',
  fontSize: 10,
  color: '#b7c1d4',
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  fontWeight: 500,
  marginBottom: 8,
};

export const fileInputStyle: CSSProperties = {
  width: '100%',
  color: '#dbe3f0',
  fontSize: 11,
};

export const fieldMetaStyle: CSSProperties = {
  margin: '8px 0 0',
  fontSize: 10,
  color: '#97a3b8',
  lineHeight: 1.45,
};

export const configGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  gap: 8,
};

export const configFieldStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 0,
};

export const textInputStyle: CSSProperties = {
  width: '100%',
  borderRadius: 10,
  border: '1px solid rgba(255,255,255,0.1)',
  background: 'rgba(6, 9, 15, 0.55)',
  color: '#f3f6fc',
  fontSize: 12,
  padding: '9px 10px',
  outline: 'none',
};

export const requiredInputStyle: CSSProperties = {
  borderColor: 'rgba(251, 146, 60, 0.4)',
};

export const hintStyle: CSSProperties = {
  fontSize: 10,
  color: '#b6becf',
  lineHeight: 1.5,
  padding: '0 2px',
};

export const errorStyle: CSSProperties = {
  padding: 8,
  background: 'rgba(220,38,38,0.16)',
  borderRadius: 12,
  border: '1px solid rgba(220,38,38,0.26)',
  fontSize: 11,
  color: '#fecaca',
  lineHeight: 1.45,
};

export const runButtonStyle: CSSProperties = {
  borderRadius: 12,
  border: '1px solid rgba(245, 158, 11, 0.28)',
  background: 'linear-gradient(135deg, rgba(180, 83, 9, 0.94), rgba(249, 115, 22, 0.92))',
  color: '#fff8ef',
  fontSize: 12,
  fontWeight: 600,
  padding: '10px 12px',
  cursor: 'pointer',
};

export const runButtonDisabledStyle: CSSProperties = {
  cursor: 'not-allowed',
  opacity: 0.45,
};

export const cardHeaderStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: 8,
  marginBottom: 8,
};

export const sectionTitleStyle: CSSProperties = {
  fontSize: 10,
  color: '#b7c1d4',
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  fontWeight: 500,
};

export const mutedTextStyle: CSSProperties = {
  fontSize: 10,
  color: '#8d97a7',
};

export const logListStyle: CSSProperties = {
  maxHeight: 140,
  overflowY: 'auto',
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
};

export const logLineStyle: CSSProperties = {
  fontSize: 10,
  color: '#d5dde9',
  lineHeight: 1.45,
  padding: '6px 8px',
  borderRadius: 8,
  background: 'rgba(255,255,255,0.025)',
};

export const metricsGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  gap: 8,
};

export const exportBtnStyle: CSSProperties = {
  padding: '3px 10px',
  fontSize: 10,
  fontWeight: 600,
  borderRadius: 6,
  border: '1px solid rgba(230,126,34,0.5)',
  background: 'rgba(230,126,34,0.15)',
  color: '#e67e22',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};

export const metricCardStyle: CSSProperties = {
  padding: '9px 10px',
  borderRadius: 12,
  background: 'rgba(255,255,255,0.03)',
  border: '1px solid rgba(255,255,255,0.06)',
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
};

export const metricLabelStyle: CSSProperties = {
  fontSize: 9,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  color: '#90a0b7',
};

export const metricValueStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  color: '#f8fafc',
};

export const metricAccentStyle: CSSProperties = {
  color: '#ffd89a',
};