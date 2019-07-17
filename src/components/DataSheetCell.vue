<template lang="pug">
  .DataSheetCell
    template(v-if="status==='updated' && oldValue != newValue")
      ins {{ newValue }}
      del {{ oldValue }}
    template(v-else)
      | {{ oldValue }}
</template>

<script>
export default {
  name: 'DataSheetCell',
  props: {
    status: {
      type: String,
      default: null,
    },
    oldValue: {
      type: [String, Number],
      default: null,
    },
    newValue: {
      type: [String, Number],
      default: null,
    },
  },
};
</script>

<style lang="postcss">
.DataSheetCell {
  ins {
    @apply block font-bold no-underline;
  }

  del {
    @apply block italic;
  }
}
</style>
