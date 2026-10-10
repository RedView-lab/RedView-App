import { describe, expect, it } from 'vitest';
import { TIMELINE_COLUMNS, type TimelineColumnDef, type TimelineColumnId } from '../TimelineColumns';
import { buildGridTemplate } from './sheetModel';

function columns(...ids: TimelineColumnId[]): TimelineColumnDef[] {
  return ids.map((id) => TIMELINE_COLUMNS.find((column) => column.id === id)!);
}

describe('buildGridTemplate', () => {
  it('ends the data columns with a filler track before the sticky actions', () => {
    // Le remplissage prend la largeur laissée par les colonnes : chaque ligne
    // couvre le tableau (plein écran), actions au bord droit.
    expect(buildGridTemplate(columns('typePicto', 'name', 'distance', 'altitude'))).toBe(
      '28px 48px 120px 75px 72px minmax(0, 1fr) 84px',
    );
  });

  it('uses the resized widths, never under a column minimum', () => {
    expect(buildGridTemplate(columns('name', 'distance'), { name: 260, distance: 10 })).toBe(
      '28px 260px 65px minmax(0, 1fr) 84px',
    );
  });
});
