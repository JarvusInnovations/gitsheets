<template lang="pug">
  tr
    td(v-for="col in columns" :key="col.name" :class="className")
      DataSheetCell(
        :status="record.status"
        :old-value="record.value[col.name]"
        :new-value="(col.name in newValues) ? newValues[col.name] : record.value[col.name]"
      )
</template>

<script>
import DataSheetCell from './DataSheetCell';

export default {
  components: { DataSheetCell },
  props: {
    columns: {
      type: Array,
      required: true,
    },
    record: {
      type: Object,
      required: true,
    },
  },
  computed: {
    className () {
      return this.record.status ? `-status-${this.record.status}` : null;
    },
    newValues () {
      if (!this.record.patch) return {};
      return this.record.patch.reduce((accum, item) => {
        const key = item.path.substr(1); // TODO: support proper nested paths
        accum[key] = item.value;
        return accum;
      }, {});
    },
  },
};
</script>
