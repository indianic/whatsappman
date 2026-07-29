import tseslint from 'typescript-eslint';

export default tseslint.config(
  // `.remember/` is agent-tool scratch, `site/client/dist` is a build artifact —
  // neither is our source, and linting them only produces noise.
  { ignores: ['dist/**', 'node_modules/**', '.remember/**', 'site/client/dist/**'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },
);
