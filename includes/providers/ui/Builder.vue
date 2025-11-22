<template>
  <div style="display: flex; flex-direction: column; flex-grow: 1;">
    <iframe
      sandbox="allow-scripts allow-same-origin allow-popups allow-modals"
      id="vueplay"
      :src="'http://localhost:3000/p#?root=root&repository=' + base + '/api/v1/git/bare.git&token=' + tokens?.accessToken"
    />
  </div>
</template>
<script>
export default {
  inject: ['apiFetch', 'apiBase', 'navTree', 'tokens'],
  props: ['sub', 'slug'],
  data: () => ({
    message: 'yes take your hands up, in the air!'
  }),
  computed: {
    base() {
      if (this.apiBase?.startsWith('http')) return this.apiBase
      return location.origin + this.apiBase
    }
  }
}
</script>

<style>
  #vueplay {
    height: 100%;
    width: 100%;
    border: none;
    outline: none;
    box-shadow: none;
    flex-grow: 1;
  }
</style>
