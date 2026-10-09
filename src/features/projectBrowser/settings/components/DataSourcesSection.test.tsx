// @vitest-environment happy-dom
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { renderComponent, type RenderedComponent } from '@/shared/test/renderComponent';
import { DATA_SOURCE_GROUPS } from '../lib/dataSources';
import { DataSourcesSection } from './DataSourcesSection';

const sources = DATA_SOURCE_GROUPS.flatMap((group) => group.sources);

describe('DATA_SOURCE_GROUPS', () => {
  it('links every source to an https page', () => {
    for (const source of sources) {
      expect(new URL(source.href).protocol, source.name).toBe('https:');
    }
  });

  it('names each source once', () => {
    const names = sources.map((source) => source.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('credits the sources whose licence requires a visible attribution', () => {
    const names = sources.map((source) => source.name);
    for (const required of ['OpenStreetMap', 'Météo-France', 'Open-Meteo', 'Kartverket', 'swisstopo', 'SLF (WSL)']) {
      expect(names).toContain(required);
    }
  });
});

describe('DataSourcesSection', () => {
  let rendered: RenderedComponent | null = null;
  afterEach(() => {
    rendered?.unmount();
    rendered = null;
  });

  it('lists every source with an external licence link that cannot reach the opener', () => {
    rendered = renderComponent(createElement(DataSourcesSection));
    const links = [...rendered.container.querySelectorAll('a')];
    expect(links).toHaveLength(sources.length + 1);
    for (const link of links) {
      expect(link.target).toBe('_blank');
      expect(link.rel).toContain('noreferrer');
    }
    expect(rendered.container.querySelector('h2')?.textContent).toBe('Sources des données');
    expect(rendered.container.textContent).toContain('© les contributeurs OpenStreetMap, ODbL 1.0');
  });
});
