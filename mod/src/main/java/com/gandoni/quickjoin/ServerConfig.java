package com.gandoni.quickjoin;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import net.fabricmc.loader.api.FabricLoader;

import java.nio.file.Files;
import java.nio.file.Path;

/**
 * Данные сервера режима. Их пишет лаунчер в
 * {@code config/gandoni-quickjoin.json} перед запуском игры.
 */
public record ServerConfig(String host, int port, String label) {

    private static final String FILE_NAME = "gandoni-quickjoin.json";

    public String address() {
        return port == 25565 ? host : host + ":" + port;
    }

    public String buttonLabel() {
        if (label != null && !label.isBlank()) {
            return label;
        }
        return "Играть на сервере";
    }

    public String serverName() {
        return (label != null && !label.isBlank()) ? label : "Сервер режима";
    }

    /** Читает конфиг из папки config текущей сборки. {@code null}, если его нет или он пуст. */
    public static ServerConfig load() {
        Path path = FabricLoader.getInstance().getConfigDir().resolve(FILE_NAME);
        if (!Files.isRegularFile(path)) {
            return null;
        }
        try {
            String text = Files.readString(path);
            JsonObject json = JsonParser.parseString(text).getAsJsonObject();
            String host = json.has("host") ? json.get("host").getAsString() : "";
            if (host == null || host.isBlank()) {
                return null;
            }
            int port = json.has("port") ? json.get("port").getAsInt() : 25565;
            String label = json.has("label") && !json.get("label").isJsonNull()
                    ? json.get("label").getAsString()
                    : null;
            return new ServerConfig(host.trim(), port, label);
        } catch (Exception error) {
            QuickJoinClient.LOGGER.warn("Не удалось прочитать {}: {}", FILE_NAME, error.toString());
            return null;
        }
    }
}
