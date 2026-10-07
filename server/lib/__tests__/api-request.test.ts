import { describe, it, expect } from 'vitest';
import { parseApiBody, parseApiQuery } from '../api-request.mjs';

describe('parseApiQuery', () => {
  it('gives one string per key, an array for a repeated key', () => {
    expect(parseApiQuery(new URLSearchParams('a=1&b=2&a=3&a=4'))).toEqual({ a: ['1', '3', '4'], b: '2' });
  });

  it('keeps empty values and decodes them', () => {
    expect(parseApiQuery(new URLSearchParams('q=Mont%20Blanc&empty='))).toEqual({ q: 'Mont Blanc', empty: '' });
  });

  it('treats constructor, toString and __proto__ as plain keys', () => {
    const query = parseApiQuery(new URLSearchParams('constructor=x&toString=y&__proto__=a&__proto__=b'));
    expect(query.constructor).toBe('x');
    expect(query.toString).toBe('y');
    expect(Object.getPrototypeOf(query)).toBeNull();
    expect(Object.entries(query)).toEqual([['constructor', 'x'], ['toString', 'y'], ['__proto__', ['a', 'b']]]);
  });
});

describe('parseApiBody', () => {
  const body = (text: string) => Buffer.from(text, 'utf-8');

  it('parses JSON, and gives {} for an empty JSON body', () => {
    expect(parseApiBody(body('{"a":1}'), 'application/json; charset=utf-8')).toEqual({ a: 1 });
    expect(parseApiBody(Buffer.alloc(0), 'application/json')).toEqual({});
  });

  it('gives the raw text for invalid JSON', () => {
    expect(parseApiBody(body('{not json'), 'application/json')).toBe('{not json');
  });

  it('gives text for text/* and forms', () => {
    expect(parseApiBody(body('---brf---'), 'text/plain; charset=UTF-8')).toBe('---brf---');
    expect(parseApiBody(body('a=1&b=2'), 'application/x-www-form-urlencoded')).toBe('a=1&b=2');
  });

  it('keeps any other body as a Buffer', () => {
    const raw = body('binary');
    expect(parseApiBody(raw, 'application/octet-stream')).toBe(raw);
    expect(parseApiBody(raw, undefined)).toBe(raw);
  });
});
