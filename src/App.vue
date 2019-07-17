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
import students from './assets/data/students.json';

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
}
</style>
