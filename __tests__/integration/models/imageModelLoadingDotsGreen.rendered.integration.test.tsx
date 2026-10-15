import { installNativeBoundary, requireRTL, GB } from '../../harness/nativeBoundary';

describe('local image model selection', () => {
  it('marks the model selected without loading it before a request', async () => {
    installNativeBoundary({
      fs: true,
      ram: { platform: 'ios', totalBytes: 12 * GB, availBytes: 8 * GB },
    });
    const React = require('react');
    const rtl = requireRTL();
    const { createONNXImageModel } = require('../../utils/factories');
    const { useAppStore } = require('../../../src/stores');
    const { activeModelService } = require('../../../src/services/activeModelService');
    const { ModelSelectorModal } = require('../../../src/components/ModelSelectorModal');
    const model = createONNXImageModel({
      id: 'theme-image',
      name: 'Theme Image',
      modelPath: '/models/theme-image',
      backend: 'coreml',
      size: 64 * 1024 * 1024,
    });
    useAppStore.getState().addDownloadedImageModel(model);

    const view = rtl.render(React.createElement(ModelSelectorModal, {
      visible: true,
      initialTab: 'image',
      onClose: () => {},
      onSelectModel: () => {},
      onUnloadModel: () => {},
      isLoading: false,
    }));

    rtl.fireEvent.press(await rtl.waitFor(() => view.getByTestId('image-model-row-theme-image')));
    await rtl.waitFor(() => expect(useAppStore.getState().activeImageModelId).toBe(model.id));
    expect(activeModelService.getActiveModels().image.isLoaded).toBe(false);
    expect(view.getByText('Selected Model')).toBeTruthy();
    expect(view.queryByText('Currently Loaded')).toBeNull();
    expect(view.queryByTestId('model-row-loading')).toBeNull();
    view.unmount();
  });
});
