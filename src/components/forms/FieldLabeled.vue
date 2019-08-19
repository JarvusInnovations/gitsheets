<template lang="pug">
  .FieldLabeled
    label.FieldLabeled__label(:for="fieldName", :class="{ 'sr-only': !showLabel }") {{ labelText }}

    template(v-if="fieldType==='textarea'")
      textarea.FieldLabeled__control(
        :name="fieldName",
        :id="fieldName",
        :required="required"
        :placeholder="placeholderText") {{ value }}

    template(v-else)
      input.FieldLabeled__control(
        :name="fieldName",
        :id="fieldName",
        :type="fieldType",
        :required="required"
        :placeholder="placeholderText",
        :value="value")
</template>

<script>
export default {
  name: 'FieldLabeled',

  props: {
    fieldName: {
      type: String,
      required: true,
    },
    fieldType: {
      type: String,
      default: 'text',
    },
    fieldLabel: {
      type: String,
      default: null,
    },
    placeholderText: {
      type: String,
      default: null,
    },
    showLabel: {
      type: Boolean,
      default: true,
    },
    value: {
      type: String,
      default: null,
    },
    required: {
      type: Boolean,
      default: false,
    },
  },

  computed: {
    labelText() {
      if (this.fieldLabel) {
        // use supplied text if available
        return this.fieldLabel;
      } else {
        // otherwise try to generate a label based on the fieldName
        let autoLabel = this.fieldName;

        autoLabel = autoLabel
          .replace(/[_\-\[\]]/g, ' ') // replace special chars with space
          .replace(/ +/g, ' '); // condense space

        // capitalize first letter
        autoLabel = autoLabel.charAt(0).toUpperCase() + autoLabel.slice(1);

        return autoLabel;
      }
    },
  },
}
</script>

<style lang="postcss">
.FieldLabeled {
  &__label {
    @apply font-light text-gray-600 text-sm;
  }

  &__control {
    @apply border border-gray-400 block leading-tight my-1 px-3 py-2 rounded shadow-inner h-full w-full;

    &:hover,
    &:focus {
      @apply border-gray-500;
    }

    &:focus {
      @apply outline-none shadow-outline;
    }
  }
}
</style>
