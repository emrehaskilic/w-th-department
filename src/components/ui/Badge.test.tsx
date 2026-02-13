import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Badge } from './Badge';

describe('Badge', () => {
  it('renders state text and live color classes', () => {
    render(<Badge state="LIVE" />);
    const element = screen.getByText('LIVE');
    expect(element).toBeInTheDocument();
    expect(element.className).toContain('text-green-400');
  });

  it('falls back to neutral class for unknown states', () => {
    render(<Badge state="UNKNOWN" />);
    const element = screen.getByText('UNKNOWN');
    expect(element.className).toContain('text-zinc-400');
  });
});
