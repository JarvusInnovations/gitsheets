<template lang="pug">
  DataSheet(:columns="columns" :records="records" :diffs="diffs")
</template>

<script>
import { mapState, mapActions } from 'vuex';

import DataSheet from '@/components/DataSheet.vue';

export default {
  components: {
    DataSheet,
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
    columns () {
      if (this.records.length > 0) {
        return Object.keys(this.records[0]).map((key) => ({ name: key }));
      } else {
        return [];
      }
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
    ...mapActions(['getRecords', 'getDiffs']),
    async fetch () {
      try {
        await this.getRecords(this.srcRef);
        if (this.dstRef) {
          const { srcRef, dstRef } = this
          await this.getDiffs({ srcRef, dstRef });
        }
      } catch (err) {
        console.error(err.message);
      }
    },
  },
};
</script>
