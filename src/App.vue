<template>
  <div id="App" class="flex flex-col">
    <div class="px-3 py-2">
      <label>
        <input v-model="showUnchanged" type="checkbox" />
        Show unchanged rows
      </label>
    </div>
    <div class="flex flex-1 overflow-hidden border-t">
      <DataSheet
        class="flex-1"
        :columns="columns"
        :records="students"
        :show-unchanged="showUnchanged"
      />
      <DataSheetLog :records="students" />
    </div>
  </div>
</template>

<script>
import DataSheet from './components/DataSheet.vue';
import DataSheetLog from './components/DataSheetLog.vue';
import students from './assets/students.json';

export default {
  name: 'App',
  components: {
    DataSheet,
    DataSheetLog,
  },
  data() {
    return {
      columns: students.columns,
      students: students.records,
      showUnchanged: true,
    };
  },
};
</script>

<style lang="postcss">
#App {
  @apply overflow-hidden;
  height: 100vh;
  width: 100vw;
}

body {
  @apply bg-gray-100 text-gray-700;
}

label {
  @apply inline-flex items-baseline;

  > input[type="checkbox"],
  > input[type="radio"] {
    @apply mr-2;
  }
}

h1,
h2,
h3,
h4,
h5,
h6 {
  @apply mb-2 text-purple-800 font-bold;
}

h1 {
  @apply text-3xl;
}

h2 {
  @apply text-2xl;
}

h3 {
  @apply text-xl;
}

h4 {
  @apply text-lg;
}

hr {
  @apply border-t;
}

a {
  @apply text-purple-700 font-bold;

  &:hover,
  &:focus {
    @apply underline;
  }

  &:focus {
    @apply outline-none rounded-sm shadow-outline;
  }
}

.sr-only {
  border: 0;
  clip: rect(0 0 0 0);
  height: auto;
  margin: 0;
  overflow: hidden;
  padding: 0;
  position: absolute;
  width: 1px;
  white-space: nowrap;
}
</style>
