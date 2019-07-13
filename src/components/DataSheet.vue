<template lang="pug">
  .overflow-y-scroll
    table.DataSheet
      thead
        tr
          th(v-for="col in columns" :key="col.name") {{ col.name }}
      transition-group(name="row" tag="tbody")
        tr(v-for="r in records" :key="r.id" v-show="showUnchanged || r.status")
          td(v-for="col in columns" :key="col.name" :class="r.status? '-status-'+ r.status: null")
            DataSheetCell(
              :status="r.status"
              :old-value="r[col.name]"
              :new-value="generateFakeNewValue(r[col.name])"
            )
</template>

<script>
import DataSheetCell from './DataSheetCell';

export default {
  name: 'DataSheet',
  components: { DataSheetCell },
  props: {
    columns: {
      type: Array,
      required: true,
    },
    records: {
      type: Array,
      required: true,
    },
    showUnchanged: {
      type: Boolean,
      default: true,
    },
  },

  methods: {
    generateFakeNewValue: val => {
      return val ? val+1 : null;
    },

    getStatusClass: status => {
      return statusClasses[status];
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
  @apply bg-white table-fixed min-w-full;
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
    @apply border-t border-b;
    background-image: linear-gradient(rgba(0, 0, 0, 0.02), transparent);
  }

  &.-status-added {
    @apply bg-green-100 border-green-200 text-green-800 font-bold;
  }

  &.-status-updated {
    @apply bg-blue-100 border-blue-200 text-blue-800;
  }

  &.-status-removed {
    @apply bg-red-100 border-red-200 text-red-800 italic line-through;
  }

  tr:hover & {
    @apply bg-gray-200 text-gray-900;

    &.-status-added {
      @apply bg-green-200 text-green-900;
    }

    &.-status-updated {
      @apply bg-blue-200 text-blue-900;

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
