const path = require('node:path');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');
module.exports = mergeConfig(getDefaultConfig(__dirname), {
  resolver: {
    resolveRequest(context, moduleName, platform) {
      const match = /^@offgrid\/(models|rag|speech|sync|ui)(\/documents)?$/.exec(moduleName);
      if (match) return { type: 'sourceFile', filePath: path.resolve(__dirname,
        `vendor/shared/packages/${match[1]}/src/${match[2] ? 'documents/' : ''}index.ts`) };
      if (moduleName === 'react-native-fs') return {
        type: 'sourceFile', filePath: path.resolve(__dirname, 'src/shims/react-native-fs.ts'),
      };
      return context.resolveRequest(context, moduleName, platform);
    },
  },
});
