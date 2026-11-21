import type { ReactNode } from 'react';
import { expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ToolsSection } from './ToolsSection';

vi.mock('./OpenCodeSettingsPanel', () => ({ OpenCodeSettingsPanel: () => <div>OpenCode settings</div> }));
vi.mock('./SettingsPanels', () => ({ SettingsPanels: ({ leftMain, centerMain }: { leftMain: ReactNode; centerMain: ReactNode }) => <div>{leftMain}{centerMain}</div> }));

it('shows OpenCode settings without legacy chat engine controls', () => {
  render(<ToolsSection />);
  expect(screen.getByText('OpenCode settings')).toBeInTheDocument();
  expect(screen.queryByText('Codex details')).toBeNull();
});
