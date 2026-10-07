import { describe, expect, it } from 'vitest';
import type { PredictionResult } from '@/features/fitPredictor';
import type { Itinerary } from '../../types';
import { followProjectPredictions, projectPredictions } from './projectPredictions';

const prediction = (label: string) => ({ label }) as unknown as PredictionResult;
const itinerary = (id: string, value?: PredictionResult | null) => ({ id, prediction: value }) as Itinerary;

describe('project predictions', () => {
  it('starts from the predictions stored on the project', () => {
    const a = prediction('a');
    expect(projectPredictions([itinerary('a', a), itinerary('b'), itinerary('c', null)])).toEqual({ a });
    expect(projectPredictions(undefined)).toEqual({});
  });

  it('follows a stored prediction that changed (undo, invalidated route, async result)', () => {
    const before = prediction('before');
    const after = prediction('after');
    const current = { a: before };
    expect(followProjectPredictions(current, [itinerary('a', before)], [itinerary('a', after)])).toEqual({ a: after });
    expect(followProjectPredictions(current, [itinerary('a', before)], [itinerary('a', null)])).toEqual({});
  });

  it('keeps a prediction the project did not change, and returns the same object when nothing moves', () => {
    const fresh = prediction('fresh, not mirrored yet');
    const current = { a: fresh };
    const same = [itinerary('a', null)];
    expect(followProjectPredictions(current, same, [itinerary('a', null)])).toBe(current);
    expect(followProjectPredictions(current, [itinerary('a', fresh)], [itinerary('a', fresh)])).toBe(current);
  });

  it('drops the prediction of a deleted itinerary and picks up a new one', () => {
    const a = prediction('a');
    const b = prediction('b');
    expect(followProjectPredictions({ a }, [itinerary('a', a)], [itinerary('b', b)])).toEqual({ b });
  });
});
