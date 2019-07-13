<template lang="pug">
  figure.FigureStat
    .FigureStat__stat {{ stat }}
    figcaption.FigureStat__label {{ label }}
</template>

<script>
export default {
  name: 'FigureStat',

  props: {
    stat: {
      type: [Number, String],
      required: true,
    },

    label: {
      type: [String],
      default: null,
    },
  },
}
</script>

<style scoped lang="postcss">
.FigureStat {
  @apply text-center;

  &__stat {
    @apply font-light leading-none text-3xl;
  }

  &__label {
    @apply font-semibold tracking-wide text-xs uppercase;
  }
}
</style>
