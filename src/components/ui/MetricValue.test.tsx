import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import MetricValue from './MetricValue';

describe('MetricValue', () => {
  it('formats currency values', () => {
    render(<MetricValue value={12.345} format="currency" />);
    const element = screen.getByText('$12.35');
    expect(element).toBeInTheDocument();
    expect(element.className).toContain('text-green-500');
  });

  it('applies reverse coloring when enabled', () => {
    render(<MetricValue value={2} reverseColor />);
    const element = screen.getByText('2.00');
    expect(element.className).toContain('text-red-500');
  });
});
