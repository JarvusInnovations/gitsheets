<template lang="pug">
  button.BaseButton(
    :type="type"
    :class="appearanceClass")
    | {{ label }}
    slot
</template>

<script>
export default {
  name: 'BaseButton',

  props: {
    label: {
      type: String,
      default: null,
    },
    type: {
      type: String,
      default: 'button',
    },
    appearance: {
      type: [Array, String],
      default: 'default',
    },
  },

  computed: {
    appearanceClass() {
      let specs = [];

      if (Array.isArray(this.appearance)) {
        specs = this.appearance
      } else {
        specs = this.appearance.split(' ');
      }

      return specs.map(spec => {
        return '-' + spec;
      }).join(' ');
    },
  },
}
</script>

<style lang="postcss">
.BaseButton {
  @apply border px-3 py-1 rounded shadow font-semibold select-none;

  background-image: linear-gradient(transparent, rgba(0, 0, 0, 0.03));

  &:focus {
    @apply border-transparent outline-none shadow-outline;
  }

  &:disabled {
    @apply border-transparent cursor-default opacity-50 pointer-events-none shadow-none;
  }

  &.w-full {
    @apply rounded-full;
  }

  /* primary */
  &.-default {
    @apply bg-gray-100 border-gray-400;

    &:hover,
    &:focus {
      @apply border-gray-500;
    }

    &:active {
      @apply bg-gray-300;
    }
  }

  /* default */
  &.-primary {
    @apply bg-purple-700 border-purple-900 text-white;
    background-image: linear-gradient(transparent, rgba(0, 0, 0, 0.1));

    &:hover,
    &:focus {
      @apply bg-purple-600;
    }

    &:active {
      @apply bg-purple-800;
    }
  }
}
</style>
