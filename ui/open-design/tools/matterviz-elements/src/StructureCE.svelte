<svelte:options customElement="mv-structure" />

<script lang="ts">
  import { Structure } from 'matterviz'

  interface Props {
    data_url?: string
  }
  let { data_url = undefined }: Props = $props()
</script>

{#if data_url}
  <Structure {data_url} show_controls="hover" allow_file_drop={false} style="width: 100%; height: 100%" />
{/if}

<style>
  :host {
    display: block;
    width: 100%;
    height: 100%;
  }
</style>
