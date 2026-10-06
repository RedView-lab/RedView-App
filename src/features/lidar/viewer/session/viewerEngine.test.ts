import { describe, expect, it } from 'vitest';
import { fallbackViewerEngine, parseViewerEngineParam, viewerEngineParamValue } from './viewerEngine';

describe('viewer engine selection', () => {
  it('parses ?engine=', () => {
    expect(parseViewerEngineParam(null)).toBe('auto');
    expect(parseViewerEngineParam('webgpu')).toBe('auto');
    expect(parseViewerEngineParam('webgl')).toBe('webgl');
    expect(parseViewerEngineParam('terrain')).toBe('terrain');
    expect(parseViewerEngineParam('anything')).toBe('auto');
  });

  it('round-trips the selector keys through the URL', () => {
    expect(viewerEngineParamValue('webgpu')).toBeNull();
    expect(parseViewerEngineParam(viewerEngineParamValue('webgl'))).toBe('webgl');
    expect(parseViewerEngineParam(viewerEngineParamValue('terrain'))).toBe('terrain');
  });

  it('moves down WebGPU → WebGL 2 → terrain after repeated GPU losses', () => {
    expect(fallbackViewerEngine('webgpu')).toBe('webgl');
    expect(fallbackViewerEngine('webgl')).toBe('terrain');
    expect(fallbackViewerEngine('terrain')).toBe('terrain');
  });
});
