<template lang="pug">
  .DataSheet-ct
    DataSheet(:records="mergedRecords")
    DataSheetLog(
      :records="mergedRecords"
      :export-url="constructExportUrl(dstRef || srcRef)"
      @commit="onCommit"
      @upload="onUpload"
    )
</template>

<script>
import { mapState, mapGetters, mapActions, mapMutations } from 'vuex';
import { uniqueNamesGenerator } from 'unique-names-generator';

import DataSheet from '@/components/DataSheet.vue';
import DataSheetLog from '@/components/DataSheetLog.vue';

export default {
  components: {
    DataSheet,
    DataSheetLog,
  },
  props: {
    srcRef: {
      type: String,
      default: 'master',
    },
    dstRef: {
      type: String,
      default: null,
    },
  },
  computed: {
    ...mapState(['records', 'diffs']),
    ...mapGetters(['constructExportUrl']),
    keyedDiffs () {
      return this.diffs.reduce((accum, item) => {
        accum[item._id] = item;
        return accum;
      }, {});
    },
    keyedRecords () {
      return this.records.reduce((accum, item) => {
        const { _id, ...value } = item
        accum[_id] = {
          _id,
          status: null,
          value,
        };
        return accum;
      }, {});
    },
    mergedRecords () {
      const diffsKeys = Object.keys(this.keyedDiffs);
      const recordsKeys = Object.keys(this.keyedRecords);
      const mergedKeys = new Set([...diffsKeys, ...recordsKeys]);

      const merged = Array.from(mergedKeys).reduce((accum, key) => {
        accum[key] = {
          ...this.keyedRecords[key],
          ...this.keyedDiffs[key],
        };
        return accum;
      }, {});
      return Object.values(merged);
    },
  },
  watch: {
    srcRef: {
      immediate: true,
      handler: 'fetch',
    },
    dstRef: 'fetch',
  },
  methods: {
    ...mapActions([
      'getRecords',
      'getDiffs',
      'merge',
      'import',
    ]),
    ...mapMutations({
      resetSheet: 'RESET_SHEET',
    }),
    async fetch () {
      const { srcRef, dstRef } = this
      const loader = this.$loading.show();

      try {
        this.resetSheet();
        await this.getRecords(srcRef);

        if (dstRef) {
          try {
            await this.getDiffs({ srcRef, dstRef });
          } catch (err) {
            this.$awn.alert(`Failed to retrieve diffs between ${srcRef} and ${dstRef}`)
            console.error(err.message);
          }
        }
      } catch (err) {
        this.$awn.alert(`Failed to retrieve branch ${srcRef}`);
        console.error(err.message);
      } finally {
        loader.hide();
      }
    },
    async onCommit (msg) {
      const { srcRef, dstRef } = this;
      const loader = this.$loading.show();

      try {
        await this.merge({ srcRef, dstRef });
        this.$router.push({ name: 'records', params: { srcRef } });
      } catch (err) {
        this.$awn.alert(`Failed to merge ${srcRef} onto ${dstRef}`);
        console.error(err.message);
      } finally {
        loader.hide();
      }
    },
    async onUpload (file) {
      const srcRef = this.dstRef || this.srcRef;
      const branch = this.generateBranchName();
      const loader = this.$loading.show();

      try {
        await this.import({ srcRef, file, branch });
        this.$router.push({ name: 'compare', params: { srcRef, dstRef: branch } });
      } catch (err) {
        this.$awn.alert(`Failed to import file branching from ${srcRef}`);
        console.error(err.message);
      } finally {
        loader.hide();
      }
    },
    generateBranchName () {
      return uniqueNamesGenerator({ separator: '-' });
    },
  },
};
</script>

<style lang="postcss">
.DataSheet-ct {
  @apply border-t overflow-hidden;
  display: grid;
  grid-template-columns: 1fr 20rem;
}
</style>
