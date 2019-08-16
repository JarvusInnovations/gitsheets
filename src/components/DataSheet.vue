<template lang="pug">
  .overflow-y-scroll
    table.DataSheet
      thead
        tr
          th(v-for="col in columns" :key="col.name") {{ col.name }}
      transition-group(name="row" tag="tbody")
        DataSheetRow(
          v-for="record in mergedRecords"
          :key="record._id"
          v-show="showUnchanged || record.status"
          :record="record"
          :columns="columns"
        )
</template>

<script>
import DataSheetRow from './DataSheetRow';

export default {
  name: 'DataSheet',
  components: { DataSheetRow },
  props: {
    columns: {
      type: Array,
      required: true,
    },
    records: {
      type: Array,
      required: true,
    },
    diffs: {
      type: Array,
      default: () => [],
    },
    showUnchanged: {
      type: Boolean,
      default: true,
    },
  },
  computed: {
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

      return Array.from(mergedKeys).reduce((accum, key) => {
        accum[key] = {
          ...this.keyedRecords[key],
          ...this.keyedDiffs[key],
        };
        return accum;
      }, {});
    },
  },
};
</script>

<style scoped lang="postcss">
td {
  @apply text-gray-500;
}
</style>

<style lang="postcss">
table {
  @apply bg-white table-fixed min-w-full whitespace-no-wrap;
}

thead {
  th {
    box-shadow: inset 0 -1px 0 rgba(0, 0, 0, 0.1);
    position: sticky;
    top: 0;
  }
}

td,
th {
  @apply p-1 text-left;
  font-feature-settings: "tnum";
  font-variant-numeric: tabular-nums;

  &:first-child {
    @apply pl-3;
  }

  &:last-child {
    @apply pr-3;
  }
}

th {
  @apply bg-indigo-200 py-2 text-gray-800;
}

td {
  &[class*="status"] {
    @apply align-top border-t border-b;
    background-image: linear-gradient(rgba(0, 0, 0, 0.02), transparent);
  }

  &.-status-added {
    @apply bg-green-100 border-green-200 text-green-800 font-bold;
  }

  &.-status-modified {
    @apply bg-blue-100 border-blue-200;

    ins,
    del {
      @apply text-blue-800;
    }
  }

  &.-status-removed {
    @apply bg-red-100 border-red-200 text-red-800 italic line-through;
  }

  tr:hover & {
    @apply bg-gray-200 text-gray-900;

    &.-status-added {
      @apply bg-green-200 text-green-900;
    }

    &.-status-modified {
      @apply bg-blue-200 text-blue-900;

      ins {
        @apply text-blue-900;
      }

      del {
        @apply no-underline;
      }
    }

    &.-status-removed {
      @apply bg-red-200 text-red-900 no-underline;
    }
  }
}
</style>
