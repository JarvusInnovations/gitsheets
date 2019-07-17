<template>
  <div id="App">
    <div class="px-3 py-2">
      <label>
        <input v-model="showUnchanged" type="checkbox" />
        Show unchanged rows
      </label>
    </div>
    <div class="DataSheet-ct">
      <DataSheet :columns="columns" :records="students" :show-unchanged="showUnchanged" />
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
  display: grid;
  grid-template-rows: auto 1fr;
  height: 100vh;
  width: 100vw;
}

.DataSheet-ct {
  @apply border-t overflow-hidden;
  display: grid;
  grid-template-columns: 1fr 20rem;
}
</style>
