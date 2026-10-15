/**
 * NoModelScreen — the empty state shown before a model is active.
 *
 * Model loading is shown in the Chat message area. This component only owns
 * the empty state before a model is selected.
 */
import React from 'react';
import { render } from '@testing-library/react-native';

jest.mock('../../../src/components', () => ({
  ModelSelectorModal: () => null,
}));
jest.mock('../../../src/services', () => ({
  llmService: { getLoadedModelPath: () => null },
}));

import { NoModelScreen } from '../../../src/screens/ChatScreen/ChatScreenComponents';
import { createStyles } from '../../../src/screens/ChatScreen/styles';
import { getTheme } from '../../../src/theme';

const theme = getTheme('light');
const colors = theme.colors;
const styles = createStyles(colors, theme.shadows);

function renderScreen(overrides: Partial<React.ComponentProps<typeof NoModelScreen>> = {}) {
  return render(
    <NoModelScreen
      styles={styles}
      colors={colors}
      navigation={{ goBack: jest.fn() }}
      hasAvailableModels
      showModelSelector={false}
      setShowModelSelector={jest.fn()}
      onSelectModel={jest.fn()}
      onUnloadModel={jest.fn()}
      isModelLoading={false}
      {...overrides}
    />,
  );
}

describe('NoModelScreen', () => {
  it('shows the "Select Model" prompt when idle (not loading)', () => {
    const { getByText } = renderScreen({ isModelLoading: false });
    expect(getByText('No Model Selected')).toBeTruthy();
    expect(getByText('Select Model')).toBeTruthy();
  });
});
