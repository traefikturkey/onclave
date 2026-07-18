-- Tag test content so it is excluded from production queries by default
UPDATE content SET tags += "test" WHERE metadata.video_id = "dQw4w9WgXcQ" AND (tags = NONE OR NOT (tags CONTAINS "test"));
