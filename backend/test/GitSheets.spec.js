const makeDir = require('make-dir');
const del = require('del');
const intoStream = require('into-stream');
const { stripIndent } = require('common-tags');

const GitSheets = require('../lib/index2');
const {
  ConfigError,
  InvalidRefError,
} = require('../lib/errors');

const GIT_DIR = process.env.GIT_DIR || 'test/tmp/GitSheets-test-repo/.git';

const sampleData = {
  initial: {
    array: [
      {id: '1', first_name: 'Ada', last_name: 'Lovelace' },
      {id: '2', first_name: 'Grace', last_name: 'Hopper' },
      {id: '3', first_name: 'Radia', last_name: 'Perlman' },
    ],
    csv: stripIndent`
      id,first_name,last_name
      1,Ada,Lovelace
      2,Grace,Hopper
      3,Radia,Perlman
    `,
  },
  changed: {
    array: [
      {id: '1', first_name: 'Ada', last_name: 'Lovelace' },
      {id: '2', first_name: 'Grace', last_name: 'Hopper-Suffix' },
      {id: '4', first_name: 'Another', last_name: 'Example' },
      {id: '5', first_name: 'Foo', last_name: 'Bar' },
    ],
    csv: stripIndent`
      id,first_name,last_name
      1,Ada,Lovelace
      2,Grace,Hopper-Suffix
      4,Another,Example
      5,Foo,Bar
    `,
  }
}

describe('GitSheets lib', () => {
  let gitSheets;

  beforeEach(async () => {
    gitSheets = await GitSheets.create(GIT_DIR);
    await makeDir(GIT_DIR);
    await gitSheets.git.init();
    await gitSheets.git.commit({
      m: 'init',
      'allow-empty': true,
    });
  });

  afterEach(async () => {
    await del([GIT_DIR]);
  });

  describe('Config', () => {
    test('setConfig saves and getConfig retrieves', async () => {
      const desiredConfig = { path: '{{id}}' };
      await gitSheets.setConfig('master', desiredConfig);
      const retrievedConfig = await gitSheets.getConfig('master');
      expect(retrievedConfig).toEqual(desiredConfig);
    });

    test('setConfigItem merges with existing config', async () => {
      const initialConfig = { path: '{{id}}' };
      await gitSheets.setConfig('master', initialConfig);
      await gitSheets.setConfigItem('master', 'foo', 'bar');
      const retrievedConfig = await gitSheets.getConfig('master');
      const expectedConfig = { ...initialConfig, foo: 'bar' };
      expect(retrievedConfig).toEqual(expectedConfig);
    })

    test('getConfig returns empty object if unset', async () => {
      const retrievedConfig = await gitSheets.getConfig('master');
      expect(retrievedConfig).toEqual({});
    });

    test('getConfigItem returns specific item value', async () => {
      const desiredConfig = { path: '{{id}}' };
      await gitSheets.setConfig('master', desiredConfig);
      const retrievedPath = await gitSheets.getConfigItem('master', 'path');
      expect(retrievedPath).toBe(desiredConfig.path);
    });

    test('getConfigItem throws ConfigError if config unset', async () => {
      await expect(gitSheets.getConfigItem('master', 'path'))
        .rejects
        .toThrow(ConfigError);
    });

    test('getConfigItem throws ConfigError if item missing', async () => {
      const initialConfig = { path: '{{id}}' };
      await gitSheets.setConfig('master', initialConfig);
      await expect(gitSheets.getConfigItem('master', 'foo'))
        .rejects
        .toThrow(ConfigError);
    });
  });

  describe('Import', () => {
    test('throws ConfigError if config unset', async () => {
      await expect(gitSheets.import({ parentRef: 'master' }))
        .rejects
        .toThrow(ConfigError);
    });

    describe('_writeDataToTree', () => {
      // This could be replaced by a hard-coded tree hash comparison
      // since they're idempotent, but this gives a bit more visibility
      // if something breaks.
      test('creates expected file for each item', async () => {
        const data = intoStream.object(sampleData.initial.array);
        const treeObject = await gitSheets._createTruncatedTree('master');
        const pathTemplate = '{{id}}';
        await gitSheets._writeDataToTree({ data, treeObject, pathTemplate });

        const keyedChildren = await treeObject.getBlobMap();
        const keys = Object.keys(keyedChildren);
        expect(keys).toEqual(['1', '2', '3']);

        await Promise.all(keys.map(async (key) => {
          const sampleDataItem = sampleData.find((item) => item.id === key);
          const contents = await keyedChildren[key].read();
          const data = gitSheets._deserialize(contents);
          expect(data).toEqual(sampleDataItem);
        }));
      })
    });
  });

  describe('Export', () => {
    test('returns expected number of objects', async () => {
      await gitSheets.setConfigItem('master', 'path', '{{id}}');
      await gitSheets.import({
        data: intoStream.object(sampleData.initial.array),
        parentRef: 'master',
        saveToBranch: 'master',
      });

      const rows = await gitSheets.export('master');
      expect(Array.isArray(rows)).toBe(true);
      expect(rows.length).toBe(sampleData.initial.array.length);
    });

    test('supports nested paths', async () => {
      await gitSheets.setConfigItem('master', 'path', '{{last_name}}/{{first_name}}');
      await gitSheets.import({
        data: intoStream.object(sampleData.initial.array),
        parentRef: 'master',
        saveToBranch: 'master',
      });

      const rows = await gitSheets.export('master');
      rows.forEach((row) => {
        expect(row).toHaveProperty('_id');
        expect(row._id).toBe(`${row.last_name}/${row.first_name}`);
      });
    });

    test('returns empty array if no data', async () => {
      const rows = await gitSheets.export('master');
      expect(Array.isArray(rows)).toBe(true);
      expect(rows.length).toBe(0);
    });

    test('requesting unknown ref throws InvalidRefError', async () => {
      await expect(gitSheets.export('unicorns'))
        .rejects
        .toThrow(InvalidRefError);
    })
  });

  describe('Compare', () => {
    it('returns expected number of diffs', async () => {
      await gitSheets.setConfigItem('master', 'path', '{{id}}');
      await gitSheets.import({
        data: intoStream.object(sampleData.initial.array),
        parentRef: 'master',
        saveToBranch: 'master',
      });
      await gitSheets.import({
        data: intoStream.object(sampleData.changed.array),
        parentRef: 'master',
        saveToBranch: 'proposed',
      });

      const diffs = await gitSheets.compare('master', 'proposed');
      expect(Array.isArray(diffs)).toBe(true);
      expect(diffs.length).toBe(4);
    });
  });
});
