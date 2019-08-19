<template>
  <div id="App">
    <RouterView />
  </div>
</template>

<script>
export default {
  name: 'App',
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
</style>
