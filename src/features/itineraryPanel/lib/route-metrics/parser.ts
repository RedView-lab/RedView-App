import type { BrouterRoute } from '../brouter';
import { classifyRoughness, classifyWayClass, encodeEngineWay, isSignalNode, isUrbanWay } from './engineCodes';
import { classifySegment, parseWayTags } from './surface';
import type { ParsedRow } from './types';

interface BrouterFeatureProps {
  messages?: unknown[][];
  [k: string]: unknown;
}

export function parseMessages(route: BrouterRoute): ParsedRow[] {
  const feat = route.raw.features?.[0];
  const props = (feat?.properties ?? {}) as BrouterFeatureProps;
  const messages = props.messages;
  if (!Array.isArray(messages) || messages.length < 2) return [];

  const header = (messages[0] as unknown[]).map((cell) => String(cell));
  const idxLon = header.indexOf('Longitude');
  const idxLat = header.indexOf('Latitude');
  const idxEle = header.indexOf('Elevation');
  const idxDist = header.indexOf('Distance');
  const idxTags = header.indexOf('WayTags');
  const idxNodeTags = header.indexOf('NodeTags');
  if (idxLon < 0 || idxLat < 0 || idxEle < 0 || idxDist < 0) return [];

  const rows: ParsedRow[] = [];
  for (let i = 1; i < messages.length; i++) {
    const row = messages[i];
    const lon = Number(row[idxLon]) / 1e6;
    const lat = Number(row[idxLat]) / 1e6;
    const ele = Number(row[idxEle]);
    const segDist = Number(row[idxDist]);
    const wayTagsStr = idxTags >= 0 ? String(row[idxTags] ?? '') : '';
    const wayTags = parseWayTags(wayTagsStr);
    const surface = idxTags >= 0 ? classifySegment(wayTagsStr) : 'unknown';
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;

    rows.push({
      lon,
      lat,
      ele: Number.isFinite(ele) ? ele : 0,
      segDistM: Number.isFinite(segDist) ? segDist : 0,
      surface,
      roughness: classifyRoughness(wayTags),
      wayCode: encodeEngineWay(classifyWayClass(wayTags), isUrbanWay(wayTags), false),
      signal: idxNodeTags >= 0 ? isSignalNode(String(row[idxNodeTags] ?? '')) : false,
    });
  }

  return rows;
}