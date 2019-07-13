<template lang="pug">
  BaseButton.SubmitButton(type="submit", :appearance="appearance")
    slot
</template>

<script>
import BaseButton from './BaseButton';

export default {
  name: 'SubmitButton',
  components: {
    BaseButton,
  },
  props: {
    appearance: {
      type: [Array, String],
      default: 'primary',
    },
  },
}
</script>
