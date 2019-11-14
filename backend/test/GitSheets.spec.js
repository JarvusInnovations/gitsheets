const makeDir = require('make-dir');
const del = require('del');
const intoStream = require('into-stream');
const getStream = require('get-stream');

const GitSheets = require('../lib/GitSheets');
const {
  ConfigError,
  InvalidRefError,
  MergeError,
} = require('../lib/errors');

const GIT_DIR = process.env.GIT_DIR || 'test/tmp/GitSheets-test-repo/.git';

const sampleData = {
  initial: [
    {id: '1', first_name: 'Ada', last_name: 'Lovelace' },
    {id: '2', first_name: 'Grace', last_name: 'Hopper' },
    {id: '3', first_name: 'Radia', last_name: 'Perlman' },
  ],
  changed: [
    {id: '1', first_name: 'Ada', last_name: 'Lovelace' },
    {id: '2', first_name: 'Grace', last_name: 'Hopper-Suffix' },
    {id: '4', first_name: 'Another', last_name: 'Example' },
    {id: '5', first_name: 'Foo', last_name: 'Bar' },
  ],
};

describe('GitSheets lib', () => {
  let gitSheets;
  let importFixture;

  beforeAll(async () => {
    gitSheets = await GitSheets.create(GIT_DIR);

    // Stateful helper functions
    importFixture = (fixture, branch) => gitSheets.import({
      data: intoStream.object(sampleData[fixture]),
      parentRef: 'master',
      saveToBranch: branch,
    });
  });

  beforeEach(async () => {
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

    test('creates commit on current branch with expected file for each item', async () => {
      await gitSheets.setConfigItem('master', 'path', '{{id}}');

      await gitSheets.import({
        data: intoStream.object(sampleData.initial),
        parentRef: 'master',
        saveToBranch: 'master',
      });

      const response = await gitSheets.git.lsTree('master');
      const tree = parseTree(response);

      const blobs = tree.filter((item) => item.type === 'blob');
      expect (blobs.length).toBe(sampleData.initial.length);

      await Promise.all(blobs.map(verifyBlob));

      async function verifyBlob ({ hash, file }) {
        const sampleDataItem = sampleData.initial.find((item) => item.id === file.substr(0, file.length - 5));
        expect(sampleDataItem).toBeDefined();

        const contents = await gitSheets.git.catFile('blob', hash);
        const data = gitSheets._deserialize(contents);
        expect(data).toEqual(sampleDataItem);
      }
    });

    test('maintains config', async () => {
      await gitSheets.setConfigItem('master', 'path', '{{id}}');

      await gitSheets.import({
        data: intoStream.object(sampleData.initial),
        parentRef: 'master',
        saveToBranch: 'master',
      });

      const path = await gitSheets.getConfigItem('master', 'path');
      expect(path).toBe('{{id}}');
    });

    test('truncates and loads', async () => {
      await gitSheets.setConfigItem('master', 'path', '{{id}}');

      await gitSheets.import({
        data: intoStream.object(sampleData.initial),
        parentRef: 'master',
        saveToBranch: 'master',
      });

      await gitSheets.import({
        data: intoStream.object(sampleData.changed),
        parentRef: 'master',
        saveToBranch: 'master',
      });

      const response = await gitSheets.git.lsTree('master');
      const tree = parseTree(response);

      const blobs = tree.filter((item) => item.type === 'blob');
      expect(blobs.length).toBe(sampleData.changed.length);

      const DELETED_ITEM_ID = '5';
      const deletedItem = tree.find((item) => item.id === DELETED_ITEM_ID);
      expect(deletedItem).not.toBeDefined();
    });

    test('supports merge mode', async () => {
      await gitSheets.setConfigItem('master', 'path', '{{id}}');

      await gitSheets.import({
        data: intoStream.object(sampleData.initial),
        parentRef: 'master',
        saveToBranch: 'master',
      });

      await gitSheets.import({
        data: intoStream.object(sampleData.changed),
        parentRef: 'master',
        saveToBranch: 'master',
        merge: true,
      });

      const response = await gitSheets.git.lsTree('master');
      const tree = parseTree(response);

      const blobs = tree.filter((item) => item.type === 'blob');

      const mergedSampleData = sampleData.initial
        .concat(sampleData.changed)
        .reduce((accum, item) => accum.set(item.id, item), new Map());

      expect(blobs.length).toBe(mergedSampleData.size);
    });

    test('supports branching', async () => {
      await gitSheets.setConfigItem('master', 'path', '{{id}}');

      await gitSheets.import({
        data: intoStream.object(sampleData.initial),
        parentRef: 'master',
        saveToBranch: 'master',
      });

      await gitSheets.import({
        data: intoStream.object(sampleData.changed),
        parentRef: 'master',
        saveToBranch: 'proposal',
      });

      const response = await gitSheets.git.lsTree('proposal');
      const tree = parseTree(response);

      const blobs = tree.filter((item) => item.type === 'blob');
      expect(blobs.length).toBe(sampleData.changed.length);
    });
  });

  describe('Export', () => {
    test('returns expected number of objects', async () => {
      await gitSheets.setConfigItem('master', 'path', '{{id}}');
      await importFixture('initial', 'master');

      const exportStream = await gitSheets.export('master');
      const rows = await getStream.array(exportStream);
      expect(Array.isArray(rows)).toBe(true);
      expect(rows.length).toBe(sampleData.initial.length);
    });

    test('supports nested paths', async () => {
      await gitSheets.setConfigItem('master', 'path', '{{last_name}}/{{first_name}}');
      await importFixture('initial', 'master');

      const exportStream = await gitSheets.export('master');
      const rows = await getStream.array(exportStream);
      rows.forEach((row) => {
        expect(row).toHaveProperty('_path');
        expect(row._path).toBe(`${row.last_name}/${row.first_name}`);
      });
    });

    test('returns empty array if no data', async () => {
      const exportStream = await gitSheets.export('master');
      const rows = await getStream.array(exportStream);
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
      await importFixture('initial', 'master');
      await importFixture('changed', 'proposed');

      const diffs = await gitSheets.compare('master', 'proposed');
      expect(Array.isArray(diffs)).toBe(true);
      expect(diffs.length).toBe(4);
    });

    it('computes expected json patch for modified row', async () => {
      await gitSheets.setConfigItem('master', 'path', '{{id}}');
      await importFixture('initial', 'master');
      await importFixture('changed', 'proposed');

      const diffs = await gitSheets.compare('master', 'proposed');
      const modifiedDiff = diffs.find((diff) => diff.status === 'modified');

      expect(modifiedDiff).toBeDefined();
      expect(modifiedDiff.patch.length).toBe(1);

      const expectedPatch = {
        op: 'replace',
        path: '/last_name',
        from: 'Hopper',
        value: 'Hopper-Suffix',
      };
      expect(modifiedDiff.patch[0]).toMatchObject(expectedPatch);
    });

    it('returns empty array for identical refs', async () => {
      await gitSheets.setConfigItem('master', 'path', '{{id}}');
      await importFixture('initial', 'master');
      await importFixture('initial', 'proposed');

      const diffs = await gitSheets.compare('master', 'proposed');
      expect(diffs).toEqual([]);
    });

    it('supports nested path templates', async () => {
      await gitSheets.setConfigItem('master', 'path', '{{last_name}}/{{first_name}}');
      await importFixture('initial', 'master');
      await importFixture('changed', 'proposed');

      const diffs = await gitSheets.compare('master', 'proposed');
      expect(Array.isArray(diffs)).toBe(true);
      expect(diffs.length).toBe(4);
    })
  });

  describe('Merge', () => {
    it('merges branches', async () => {
      await gitSheets.setConfigItem('master', 'path', '{{id}}');
      await importFixture('initial', 'master');
      await importFixture('changed', 'proposed');

      await gitSheets.merge('master', 'proposed');

      const response = await gitSheets.git.lsTree('master');
      const tree = parseTree(response);

      const blobs = tree.filter((item) => item.type === 'blob');
      expect(blobs.length).toBe(sampleData.changed.length);
    });

    it('deletes merged branch', async () => {
      await gitSheets.setConfigItem('master', 'path', '{{id}}');
      await importFixture('initial', 'master');
      await importFixture('changed', 'proposed');

      await gitSheets.merge('master', 'proposed');

      await expect(gitSheets.export('proposed'))
        .rejects
        .toThrow(InvalidRefError);
    });

    it('throws error when merging onto non-ancestor', async () => {
      await gitSheets.setConfigItem('master', 'path', '{{id}}');
      await importFixture('initial', 'master');
      await importFixture('changed', 'proposed');

      const conflictingData = [
        { id: 1, first_name: 'empty', last_name: 'empty', email: 'empty', dob: 'empty' },
      ];

      await gitSheets.import({
        data: intoStream.object(conflictingData),
        parentRef: 'master',
        saveToBranch: 'master',
      });

      await expect(gitSheets.merge('master', 'proposed'))
        .rejects
        .toThrow(MergeError);
    });
  });
});

function parseTree (treeOutput) {
  const TREE_PATTERN = /(?<mode>\d{6}) (?<type>\w+) (?<hash>\w+)\t(?<file>.+)/;

  return treeOutput
    .trim()
    .split('\n')
    .map((line) => TREE_PATTERN.exec(line).groups);
}
