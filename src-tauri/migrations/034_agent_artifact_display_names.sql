UPDATE agent_artifacts
SET display_name = (
  SELECT json_extract(attachment.value, '$.name')
  FROM agent_items
  JOIN json_each(agent_items.payload_json, '$.attachments') AS attachment
  WHERE agent_items.id = agent_artifacts.item_id
    AND json_extract(attachment.value, '$.path') = agent_artifacts.path
  LIMIT 1
)
WHERE provenance = 'attachment'
  AND display_name IS NULL
  AND item_id IS NOT NULL;
