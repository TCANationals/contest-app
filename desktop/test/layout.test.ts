import { describe, expect, it } from 'vitest';

import { layoutForCorner } from '../src/layout';
import type { PositionCorner } from '../src/types';

describe('layoutForCorner', () => {
  it('anchors top-left content to the window top-left', () => {
    expect(layoutForCorner('topLeft')).toEqual({
      alignItems: 'flex-start',
      justifyContent: 'flex-start',
      textAlign: 'left',
    });
  });

  it('anchors top-right content to the window top-right', () => {
    expect(layoutForCorner('topRight')).toEqual({
      alignItems: 'flex-end',
      justifyContent: 'flex-start',
      textAlign: 'right',
    });
  });

  it('anchors bottom-left content to the window bottom-left', () => {
    expect(layoutForCorner('bottomLeft')).toEqual({
      alignItems: 'flex-start',
      justifyContent: 'flex-end',
      textAlign: 'left',
    });
  });

  it('anchors bottom-right content to the window bottom-right', () => {
    expect(layoutForCorner('bottomRight')).toEqual({
      alignItems: 'flex-end',
      justifyContent: 'flex-end',
      textAlign: 'right',
    });
  });

  it('falls back to centred layout for unknown values', () => {
    // Cast through `unknown` so we can simulate a future / malformed
    // value coming off the Tauri event bus without lying to the type
    // system at the call sites in production code.
    expect(layoutForCorner('mystery' as unknown as PositionCorner)).toEqual({
      alignItems: 'center',
      justifyContent: 'center',
      textAlign: 'center',
    });
  });
});
