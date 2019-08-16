<template lang="pug">
  DataSheet(:columns="columns" :records="records")
</template>

<script>
import { mapState, mapActions } from 'vuex';

import DataSheet from '@/components/DataSheet.vue';

export default {
  components: {
    DataSheet,
  },
  props: {
    gitRef: {
      type: String,
      default: 'master',
    },
  },
  computed: {
    ...mapState(['records']),
    columns () {
      if (this.records.length > 0) {
        return Object.keys(this.records[0]).map((key) => ({ name: key }));
      } else {
        return [];
      }
    },
  },
  watch: {
    gitRef: {
      immediate: true,
      handler: 'fetch',
    },
  },
  methods: {
    ...mapActions(['getRecords']),
    async fetch () {
      try {
        await this.getRecords(this.gitRef);
      } catch (err) {
        console.error(err.message);
      }
    },
  },
};
</script>
